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

  // Artwork for a video, resized to `width` and cached. `kind` is "poster", "backdrop" or
  // "frame" and `src` is the image to use, if there is one. Without a source, a poster
  // does not exist and a backdrop falls back to a frame from 10% into the video.
  async art(item, kind, width, src) {
    if (kind === 'poster' && !src) return null;
    const base = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const scale = ['-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '3', '-y'];
    if (src) {
      const stamp = Math.floor((await fsp.stat(src)).mtimeMs);
      const out = path.join(this.thumbDir, `${item.id}-${kind}-${width}-${stamp}.jpg`);
      return this._cached(out, (tmp) => run('ffmpeg', [...base, '-i', src, ...scale, tmp]));
    }
    const out = path.join(this.thumbDir, `${item.id}-frame-${width}-${item.mtime}.jpg`);
    const at = item.duration ? Math.min(item.duration * 0.1, 300) : 0;
    return this._cached(out, (tmp) => run('ffmpeg', [
      ...base, '-ss', at.toFixed(2), '-i', item.path, '-map', `0:${item.vindex}`, ...scale, tmp,
    ]));
  }

  // A small frame for the timeline's hover preview. Times are snapped to a bucket so one
  // video never produces more than about 240 of them.
  preview(item, t) {
    const step = Math.max(10, Math.ceil(item.duration / 240));
    const at = Math.max(0, Math.min(Math.floor(t / step) * step, Math.max(0, item.duration - 1)));
    const out = path.join(this.thumbDir, `${item.id}-pv-${at}-${item.mtime}.jpg`);
    return this._cached(out, (tmp) => run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(at), '-i', item.path,
      '-map', `0:${item.vindex}`, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '6', '-y', tmp,
    ], 30000));
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
