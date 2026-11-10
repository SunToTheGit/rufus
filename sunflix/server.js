#!/usr/bin/env node
'use strict';
// SunFlix: a small self-hosted media server. No npm dependencies; needs
// Node 18+ and ffmpeg/ffprobe on the PATH.
//
//   node server.js /path/to/movies /path/to/shows
//
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Library, readJson, writeJson } = require('./lib/library');
const { Media } = require('./lib/media');
const { Tmdb } = require('./lib/tmdb');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.SUNFLIX_DATA || path.join(ROOT, 'data'));
const PASSWORD = process.env.SUNFLIX_PASSWORD || '';
const RESCAN_MINUTES = Number(process.env.SUNFLIX_RESCAN_MINUTES ?? 30);

let dirs = process.argv.slice(2);
if (!dirs.length) dirs = (process.env.SUNFLIX_MEDIA || '').split(path.delimiter).filter(Boolean);
if (!dirs.length) {
  dirs = [path.join(ROOT, 'media')];
  fs.mkdirSync(dirs[0], { recursive: true });
}
dirs = dirs.map((d) => path.resolve(d));

for (const tool of ['ffmpeg', 'ffprobe']) {
  try { execFileSync(tool, ['-version'], { stdio: 'ignore' }); } catch {
    console.error(`SunFlix needs ${tool} on the PATH. Install ffmpeg and try again.`);
    process.exit(1);
  }
}

fs.mkdirSync(DATA, { recursive: true });
const lib = new Library({ dirs, dataDir: DATA });
const media = new Media(DATA);
const tmdb = process.env.TMDB_API_KEY
  ? new Tmdb({ key: process.env.TMDB_API_KEY.trim(), dataDir: DATA, apiUrl: process.env.TMDB_API_URL, imageUrl: process.env.TMDB_IMAGE_URL })
  : null;

// Scan the folders, then look up anything new on TMDB when that is switched on.
function rescan() {
  return lib.scan().then(() => tmdb && tmdb.sync(lib.all()));
}

// Artwork next to the files wins; TMDB fills the gaps.
function artSource(it, kind) {
  const meta = tmdb && tmdb.for(it);
  if (kind === 'logo') return meta ? meta.logo : null;
  if (kind === 'frame') return null;
  return it[kind] || (meta ? meta[kind] : null);
}

// ---------------------------------------------------------------- progress

const progressFile = path.join(DATA, 'progress.json');
const progress = readJson(progressFile, {});
let saveTimer = null;
function saveProgress() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeJson(progressFile, progress); }, 1000);
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); writeJson(progressFile, progress); }
  process.exit(0);
}
process.on('SIGINT', flush);
process.on('SIGTERM', flush);

const byEpisode = (a, b) => a.season - b.season || a.episode - b.episode;

// In-progress videos, plus the next episode of any show whose latest episode was finished.
function continueIds() {
  const stamp = new Map();
  const shows = new Map();
  for (const it of lib.all()) {
    const p = progress[it.id];
    if (p && !p.watched && p.position > 15) stamp.set(it.id, p.updatedAt);
    if (it.type === 'episode') {
      if (!shows.has(it.showKey)) shows.set(it.showKey, []);
      shows.get(it.showKey).push(it);
    }
  }
  for (const eps of shows.values()) {
    eps.sort(byEpisode);
    let last = -1;
    eps.forEach((e, i) => {
      const p = progress[e.id];
      if (p && (last < 0 || p.updatedAt > progress[eps[last].id].updatedAt)) last = i;
    });
    if (last < 0 || !progress[eps[last].id].watched) continue;
    const next = eps[last + 1];
    if (next && !(progress[next.id] || {}).watched && !stamp.has(next.id)) {
      stamp.set(next.id, progress[eps[last].id].updatedAt);
    }
  }
  return [...stamp].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id]) => id);
}

// What the browser gets to know about a video. File paths stay on the server.
function publicItem(it) {
  const p = progress[it.id];
  const meta = tmdb && tmdb.for(it);
  const isEp = it.type === 'episode';
  const ep = isEp && meta ? meta.episodes[`${it.season}x${it.episode}`] : null;
  return {
    id: it.id, type: it.type,
    title: isEp ? (ep && ep.title) || it.title : (meta && meta.title) || it.title,
    year: (meta && meta.year) || it.year,
    show: isEp ? (meta && meta.title) || it.show : undefined,
    showKey: it.showKey, season: it.season, episode: it.episode,
    // Episodes carry their own synopsis; everything about the show is sent once, in `shows`.
    overview: isEp ? (ep && ep.overview) || '' : meta ? meta.overview : '',
    ...(meta && !isEp ? { tagline: meta.tagline, genres: meta.genres, rating: meta.rating, cast: meta.cast, directors: meta.directors } : {}),
    hasLogo: Boolean(artSource(it, 'logo')),
    duration: it.duration, width: it.width, height: it.height,
    vcodec: it.vcodec, size: it.size, addedAt: it.addedAt, playback: it.playback,
    file: path.basename(it.path), hasPoster: Boolean(artSource(it, 'poster')), hasBackdrop: Boolean(artSource(it, 'backdrop')),
    audio: it.audio,
    subs: [
      ...it.embedded.map((s) => ({ key: `e${s.n}`, lang: s.lang, title: s.title })),
      ...it.sidecars.map((s, n) => ({ key: `s${n}`, lang: s.lang, title: null })),
    ],
    position: p ? p.position : 0,
    watched: Boolean(p && p.watched),
  };
}

// Show-level details, keyed like the client groups episodes.
function showMeta() {
  const out = {};
  if (!tmdb) return out;
  for (const it of lib.all()) {
    if (it.type !== 'episode' || out[it.showKey]) continue;
    const m = tmdb.for(it);
    if (m) out[it.showKey] = { overview: m.overview, tagline: m.tagline, genres: m.genres, rating: m.rating, cast: m.cast, creators: m.creators };
  }
  return out;
}

// -------------------------------------------------------------------- auth

const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();
const SESSION_DAYS = 30;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const sameString = (a, b) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function authed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)sunflix=(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || '');
  return Boolean(m) && Number(m[1]) > Date.now() && sameString(m[2], sign(m[1]));
}

const failures = new Map(); // ip -> [timestamps]
function tooManyFailures(ip) {
  const recent = (failures.get(ip) || []).filter((t) => t > Date.now() - 10 * 60 * 1000);
  failures.set(ip, recent);
  return recent.length >= 10;
}

// ----------------------------------------------------------------- helpers

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.vtt': 'text/vtt; charset=utf-8', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Serves a file with HTTP range support, which is what lets the browser seek.
function sendFile(req, res, file, cacheControl) {
  let st;
  try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not found' });
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
  };
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(0, st.size - Number(range[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !st.size) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function sendStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'not found' });
  sendFile(req, res, file, 'no-cache');
}

// ------------------------------------------------------------------ routes

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad path' }); }
  const [area, a, b] = pathname.split('/').filter(Boolean);
  const method = req.method;

  if (method === 'POST') {
    // Stops other websites from posting to this server through the visitor's browser.
    const origin = req.headers.origin;
    let ok = true;
    if (origin) { try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; } }
    if (!ok) return json(res, 403, { error: 'cross-origin request refused' });
  } else if (method !== 'GET' && method !== 'HEAD') {
    return json(res, 405, { error: 'method not allowed' });
  }

  if (area === 'api' && a === 'login' && method === 'POST') {
    const ip = req.socket.remoteAddress || '';
    if (tooManyFailures(ip)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const body = await readBody(req);
    if (!PASSWORD || !sameString(String(body.password || ''), PASSWORD)) {
      failures.get(ip).push(Date.now());
      return json(res, 401, { error: 'Wrong password.' });
    }
    const exp = String(Date.now() + SESSION_DAYS * 86400000);
    return json(res, 200, { ok: true }, {
      'Set-Cookie': `sunflix=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }

  const isMedia = ['api', 'stream', 'transcode', 'subs', 'art', 'preview'].includes(area);
  if (!isMedia) return sendStatic(req, res, pathname);
  if (!authed(req)) return json(res, 401, { error: 'login required' });

  if (area === 'api') {
    if (a === 'logout' && method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sunflix=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }
    if (a === 'library' && method === 'GET') {
      return json(res, 200, {
        items: lib.all().map(publicItem),
        continue: continueIds(),
        status: lib.status,
        shows: showMeta(),
        metadata: tmdb ? tmdb.status : null,
        mediaDirs: dirs,
        canLogout: Boolean(PASSWORD),
      });
    }
    if (a === 'scan' && method === 'POST') {
      rescan();
      return json(res, 202, { status: lib.status });
    }
    const item = b ? lib.get(b) : null;
    if (a === 'progress' && method === 'POST' && item) {
      const body = await readBody(req);
      const position = Math.max(0, Number(body.position) || 0);
      const watched = item.duration > 0 && position >= item.duration * 0.92;
      progress[item.id] = { position: watched ? 0 : position, watched, updatedAt: Date.now() };
      saveProgress();
      return json(res, 200, progress[item.id]);
    }
    if (a === 'start' && method === 'GET' && item) {
      const t = Math.max(0, Number(url.searchParams.get('t')) || 0);
      return json(res, 200, { start: await media.startPoint(item, t) });
    }
    if (a === 'watched' && method === 'POST' && item) {
      const body = await readBody(req);
      progress[item.id] = { position: 0, watched: Boolean(body.watched), updatedAt: Date.now() };
      saveProgress();
      return json(res, 200, progress[item.id]);
    }
    return json(res, 404, { error: 'not found' });
  }

  const item = a ? lib.get(a) : null;
  if (!item) return json(res, 404, { error: 'not found' });

  if (area === 'stream') return sendFile(req, res, item.path, 'private, max-age=0');

  if (area === 'art') {
    const kind = ['poster', 'backdrop', 'logo'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'frame';
    const width = [400, 640, 1920].includes(Number(url.searchParams.get('w'))) ? Number(url.searchParams.get('w')) : 640;
    try {
      // Title logos are transparent PNGs, so they are sent as they are instead of being re-encoded.
      const file = kind === 'logo' ? artSource(item, 'logo') : await media.art(item, kind, width, artSource(item, kind));
      if (!file) return json(res, 404, { error: 'no artwork' });
      return sendFile(req, res, file, 'private, max-age=86400');
    } catch {
      return json(res, 404, { error: 'no artwork' });
    }
  }

  if (area === 'preview') {
    try {
      return sendFile(req, res, await media.preview(item, Number(url.searchParams.get('t')) || 0), 'private, max-age=86400');
    } catch {
      return json(res, 404, { error: 'no preview' });
    }
  }

  if (area === 'subs') {
    const job = media.subtitles(item, b || '');
    if (!job) return json(res, 404, { error: 'not found' });
    try { return sendFile(req, res, await job, 'private, max-age=86400'); } catch {
      return json(res, 500, { error: 'could not read subtitles' });
    }
  }

  if (area === 'transcode') {
    const start = Math.max(0, Number(url.searchParams.get('t')) || 0);
    let audio = Number(url.searchParams.get('a')) || 0;
    if (!Number.isInteger(audio) || audio < 0 || audio >= item.audio.length) audio = 0;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    if (method === 'HEAD') return res.end();
    const ff = media.transcode(item, start, audio);
    let errText = '';
    ff.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
    ff.stdout.pipe(res);
    ff.on('error', () => res.destroy());
    ff.on('close', (code) => {
      if (code && !res.destroyed) console.error(`[transcode] ${path.basename(item.path)}: ${errText.trim().split('\n').pop()}`);
    });
    res.on('close', () => ff.kill('SIGKILL'));
    return undefined;
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, err instanceof SyntaxError ? 400 : 500, { error: 'request failed' });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SunFlix is up: http://localhost:${PORT}`);
  console.log(`Media folders:\n${dirs.map((d) => `  ${d}`).join('\n')}`);
  if (!PASSWORD) console.log('No password set. Anyone on your network can watch. Set SUNFLIX_PASSWORD to lock it.');
  console.log(tmdb ? 'Looking up titles on TMDB.' : 'No TMDB_API_KEY set. Titles and artwork come from your files only.');
  rescan();
  if (RESCAN_MINUTES > 0) setInterval(rescan, RESCAN_MINUTES * 60000).unref();
});
