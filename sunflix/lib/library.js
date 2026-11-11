'use strict';
// Scans media folders, probes each video with ffprobe and keeps the result in
// a JSON file so restarts and rescans only probe files that changed.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { VIDEO_EXT, parseMedia } = require('./parse');

const SCHEMA = 1;
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

const idFor = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// How the browser can be fed this file: as-is, repackaged, or re-encoded.
function playbackMode(it) {
  const h264 = it.vcodec === 'h264' && /^yuvj?420p$/.test(it.pixfmt || '');
  const vOk = h264 || ['vp8', 'vp9', 'av1'].includes(it.vcodec);
  const a = it.audio[0];
  const aOk = !a || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(a.codec);
  const cOk = ['.mp4', '.m4v', '.mov', '.webm'].includes(path.extname(it.path).toLowerCase());
  if (vOk && aOk && cOk) return 'direct';
  return h264 ? 'remux' : 'transcode';
}

function findImage(names, dir, candidates) {
  if (!names) return null;
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const c of candidates) {
    for (const ext of IMG_EXT) {
      const hit = lower.get((c + ext).toLowerCase());
      if (hit) return path.join(dir, hit);
    }
  }
  return null;
}

class Library {
  constructor({ dirs, dataDir }) {
    this.dirs = dirs;
    this.file = path.join(dataDir, 'library.json');
    const saved = readJson(this.file, {});
    this.items = saved.schema === SCHEMA ? saved.items || {} : {};
    this.status = { scanning: false, total: 0, done: 0, lastScan: saved.lastScan || null, failed: 0 };
    this.scanPromise = null;
  }

  get(id) { return Object.hasOwn(this.items, id) ? this.items[id] : null; }
  all() { return Object.values(this.items); }

  scan() {
    if (!this.scanPromise) {
      this.scanPromise = this._scan()
        .catch((err) => console.error('[scan] failed:', err.message))
        .finally(() => { this.status.scanning = false; this.scanPromise = null; });
    }
    return this.scanPromise;
  }

  async _walk(dir, found, listings, seen) {
    let real;
    try { real = await fsp.realpath(dir); } catch { return; }
    if (seen.has(real)) return; // symlink loop
    seen.add(real);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    listings.set(dir, entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.isDirectory()) await this._walk(full, found, listings, seen);
      else if (st.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        found.push({ path: full, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
  }

  async _scan() {
    const status = this.status;
    Object.assign(status, { scanning: true, total: 0, done: 0, failed: 0 });
    const found = [];
    const listings = new Map();
    const offline = [];
    for (const root of this.dirs) {
      try { await fsp.access(root); } catch { offline.push(root); continue; }
      await this._walk(root, found, listings, new Set());
    }
    status.total = found.length;

    const next = {};
    const limit = limiter(4);
    await Promise.all(found.map((f) => limit(async () => {
      const id = idFor(f.path);
      const old = this.get(id);
      let probed = old && old.size === f.size && old.mtime === f.mtime ? old : null;
      if (!probed) {
        try { probed = await this._probe(f); } catch { status.failed++; }
      }
      if (probed) {
        const meta = parseMedia(f.path);
        const dir = path.dirname(f.path);
        const base = path.basename(f.path, path.extname(f.path));
        const artDir = meta.type === 'episode' ? meta.showDir : dir;
        const own = meta.type === 'movie' ? [`${base}-poster`, base] : [];
        const item = {
          ...probed, ...meta, id, path: f.path, size: f.size, mtime: f.mtime,
          addedAt: old ? old.addedAt : f.mtime,
          poster: findImage(listings.get(artDir), artDir, [...own, 'poster', 'folder', 'cover']),
          backdrop: findImage(listings.get(artDir), artDir, [`${base}-fanart`, `${base}-backdrop`, 'backdrop', 'fanart', 'background']),
          sidecars: (listings.get(dir) || [])
            .filter((n) => n.startsWith(`${base}.`) && SUB_EXT.has(path.extname(n).toLowerCase()))
            .sort()
            .map((n) => ({ file: path.join(dir, n), lang: n.slice(base.length + 1, -path.extname(n).length) || null })),
        };
        delete item.showDir;
        item.playback = playbackMode(item);
        next[id] = item;
      }
      status.done++;
    })));

    // A drive that is unplugged right now should not wipe its part of the library.
    for (const old of this.all()) {
      if (offline.some((root) => old.path.startsWith(root + path.sep))) next[old.id] = old;
    }
    this.items = next;
    status.lastScan = Date.now();
    writeJson(this.file, { schema: SCHEMA, lastScan: status.lastScan, items: next });
    console.log(`[scan] ${Object.keys(next).length} videos` + (status.failed ? `, ${status.failed} unreadable` : ''));
  }

  async _probe(f) {
    const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f.path]);
    const info = JSON.parse(out);
    const streams = info.streams || [];
    const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || null;
    const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (!v) throw new Error('no video stream');
    const duration = parseFloat(info.format && info.format.duration) || parseFloat(v.duration) || 0;
    return {
      duration,
      width: v.width || 0,
      height: v.height || 0,
      vcodec: v.codec_name,
      vindex: v.index,
      pixfmt: v.pix_fmt || null,
      audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({
        codec: s.codec_name, channels: s.channels || 0, lang: tag(s, 'language'), title: tag(s, 'title'),
      })),
      embedded: streams.filter((s) => s.codec_type === 'subtitle').map((s, n) => ({
        n, codec: s.codec_name, lang: tag(s, 'language'), title: tag(s, 'title'),
      })).filter((s) => TEXT_SUBS.has(s.codec)),
    };
  }
}

module.exports = { Library, run, limiter, readJson, writeJson };
