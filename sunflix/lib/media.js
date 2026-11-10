'use strict';
// Everything that touches ffmpeg at request time: thumbnails, subtitle
// conversion and the live transcode stream.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, limiter } = require('./library');

// H.264 the browser can decode as-is, so the video stream can be copied instead of re-encoded.
const canCopy = (item) => item.vcodec === 'h264' && /^yuvj?420p$/.test(item.pixfmt || '');

class Media {
  constructor(dataDir) {
    this.thumbDir = path.join(dataDir, 'thumbs');
    this.subDir = path.join(dataDir, 'subs');
    fs.mkdirSync(this.thumbDir, { recursive: true });
    fs.mkdirSync(this.subDir, { recursive: true });
    this.limit = limiter(2);
    this.pending = new Map();
  }

  // Runs `make(tmpPath)` once per output file, even under concurrent requests.
  async _cached(out, make) {
    try { await fsp.access(out); return out; } catch { /* not built yet */ }
    if (!this.pending.has(out)) {
      const tmp = `${out}.tmp${path.extname(out)}`;
      const job = this.limit(async () => {
        try {
          await make(tmp);
          await fsp.rename(tmp, out);
          return out;
        } finally {
          fsp.rm(tmp, { force: true }).catch(() => {});
          this.pending.delete(out);
        }
      });
      this.pending.set(out, job);
    }
    return this.pending.get(out);
  }

  // A frame from 10% into the video, used wherever there is no artwork on disk.
  thumb(item) {
    const out = path.join(this.thumbDir, `${item.id}-${item.mtime}.jpg`);
    const at = item.duration ? Math.min(item.duration * 0.1, 300) : 0;
    return this._cached(out, (tmp) => run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', at.toFixed(2), '-i', item.path,
      '-map', `0:${item.vindex}`, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', tmp,
    ]));
  }

  // key is "e<n>" for the nth embedded text track or "s<n>" for the nth sidecar file.
  subtitles(item, key) {
    const m = /^([es])(\d+)$/.exec(key);
    if (!m) return null;
    const n = Number(m[2]);
    const base = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    let input;
    if (m[1] === 'e') {
      if (!item.embedded.some((s) => s.n === n)) return null;
      input = ['-i', item.path, '-map', `0:s:${n}`];
    } else {
      const side = item.sidecars[n];
      if (!side) return null;
      if (side.file.toLowerCase().endsWith('.vtt')) return Promise.resolve(side.file);
      input = ['-i', side.file];
    }
    const out = path.join(this.subDir, `${item.id}-${item.mtime}-${key}.vtt`);
    return this._cached(out, (tmp) => run('ffmpeg', [...base, ...input, '-f', 'webvtt', '-y', tmp], 600000));
  }

  // Where a stream asked to start at `t` will really begin. Copied video can only
  // be cut on a keyframe, so the player needs this to keep its clock and subtitles right.
  async startPoint(item, t) {
    if (!canCopy(item) || !(t > 0)) return Math.max(0, t);
    try {
      const out = await run('ffprobe', ['-v', 'error', '-select_streams', String(item.vindex),
        '-read_intervals', `${t.toFixed(3)}%+#1`, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', item.path], 15000);
      const key = parseFloat(out);
      return Number.isFinite(key) && key <= t ? Math.max(0, key) : t;
    } catch {
      return t;
    }
  }

  // Streams the file as fragmented MP4 (H.264 + AAC) starting at `start` seconds.
  // Video is copied untouched when it is already browser-friendly H.264.
  transcode(item, start, audioIndex) {
    const copy = canCopy(item);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    // ffmpeg aims a little early when it seeks, so a start that sits exactly on a keyframe can
    // fall back to the one before. Aiming just past it lands on the keyframe we reported.
    if (start > 0) args.push('-ss', (start + (copy ? 0.2 : 0)).toFixed(3));
    args.push('-i', item.path, '-map', `0:${item.vindex}`);
    if (item.audio.length) args.push('-map', `0:a:${audioIndex}`, '-c:a', 'aac', '-ac', '2', '-b:a', '160k');
    if (copy) args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-g', '48');
    args.push('-sn', '-dn', '-max_muxing_queue_size', '1024',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

module.exports = { Media };
