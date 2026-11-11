#!/usr/bin/env node
'use strict';
// Turns your media folders into a plain website: no SunFlix server needed afterwards.
//
//   node publish.js /path/to/movies /path/to/shows --out ./site-out --media-url https://media.example.com
//   node publish.js --serve ./site-out          (try the result on this computer)
//
// It writes two folders:
//   <out>/site    the pages, the library list, artwork and subtitles. Small. Goes on Netlify.
//   <out>/media   the videos and scrub previews. Large. Goes in a storage bucket.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');
const { Library, limiter, readJson, writeJson } = require('./lib/library');
const { Media } = require('./lib/media');
const { Tmdb } = require('./lib/tmdb');
const catalog = require('./lib/catalog');

const PUBLIC = path.join(__dirname, 'public');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv.splice(i, 2)[1] || '';
};
const serveDir = flag('--serve');
const outArg = flag('--out');
const mediaUrl = (flag('--media-url') || '').replace(/\/+$/, '');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ------------------------------------------------------------ preview server

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.vtt': 'text/vtt; charset=utf-8', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
};

// Serves <dir>/site at / and <dir>/media at /media, so a published folder can be checked locally.
function serve(dir) {
  const root = path.resolve(dir);
  const port = Number(process.env.PORT) || 8788;
  http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    const base = rel.startsWith('/media/') ? root : path.join(root, 'site');
    const file = path.join(base, rel === '/' ? 'index.html' : rel);
    let st;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!file.startsWith(base + path.sep) || !st || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = st.size - 1;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && Number(m[1]) < st.size) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), end);
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(headers['Content-Range'] ? 206 : 200, headers);
    if (req.method === 'HEAD' || !st.size) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }).listen(port, () => console.log(`Previewing ${root} at http://localhost:${port}`));
}

// ------------------------------------------------------------------ publish

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, so, se) => (err ? reject(new Error(String(se || err.message).trim().split('\n').pop())) : resolve()));
});

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

// Copies without using extra disk space when both folders are on the same drive.
async function place(src, dest) {
  await fsp.rm(dest, { force: true });
  try { await fsp.link(src, dest); } catch { await fsp.copyFile(src, dest); }
}

async function publish(dirs, out) {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try { execFileSync(tool, ['-version'], { stdio: 'ignore' }); } catch { fail(`publish needs ${tool} on the PATH. Install ffmpeg and try again.`); }
  }
  const dataDir = path.resolve(process.env.SUNFLIX_DATA || path.join(__dirname, 'data'));
  const site = path.join(out, 'site');
  const mediaOut = path.join(out, 'media');
  for (const d of [dataDir, path.join(site, 'art'), path.join(site, 'subs'), path.join(mediaOut, 'videos'), path.join(mediaOut, 'previews'), path.join(mediaOut, 'audio')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Remembers which version of each source file the published video and previews were made
  // from, so running publish again only redoes what changed. Kept outside the uploaded folders.
  const stateFile = path.join(out, '.publish-state.json');
  const state = { videos: {}, previews: {}, audio: {}, ...readJson(stateFile, {}) };

  const lib = new Library({ dirs, dataDir });
  const media = new Media(dataDir);
  const tmdb = process.env.TMDB_API_KEY
    ? new Tmdb({ key: process.env.TMDB_API_KEY.trim(), dataDir, apiUrl: process.env.TMDB_API_URL, imageUrl: process.env.TMDB_IMAGE_URL })
    : null;

  console.log('Scanning…');
  await lib.scan();
  if (tmdb) { console.log('Looking up titles on TMDB…'); await tmdb.sync(lib.all()); }
  const items = lib.all();
  if (!items.length) fail(`No videos found in:\n${dirs.map((d) => `  ${d}`).join('\n')}`);

  // One image file per source picture, so a show's poster is stored once, not once per episode.
  const artJobs = new Map();
  function art(it, kind, width) {
    const src = catalog.artSource(tmdb, it, kind);
    if (kind === 'logo') {
      if (!src) return null;
      const name = `${crypto.createHash('sha1').update(src).digest('hex').slice(0, 16)}-logo${path.extname(src)}`;
      if (!artJobs.has(name)) artJobs.set(name, place(src, path.join(site, 'art', name)).then(() => `art/${name}`, () => null));
      return artJobs.get(name);
    }
    if (kind === 'poster' && !src) return null;
    const owner = src ? crypto.createHash('sha1').update(src).digest('hex').slice(0, 16) : it.id;
    const name = `${owner}-${src ? kind : 'frame'}-${width}.jpg`;
    if (!artJobs.has(name)) {
      artJobs.set(name, media.art(it, kind, width, src).then((file) => place(file, path.join(site, 'art', name))).then(() => `art/${name}`, () => null));
    }
    return artJobs.get(name);
  }

  const copyable = (it) => it.playback === 'direct' && ['.mp4', '.m4v', '.webm'].includes(path.extname(it.path).toLowerCase());

  // The video itself: used as it is when browsers can play it, converted to MP4 once when they cannot.
  async function video(it) {
    const ext = copyable(it) ? path.extname(it.path).toLowerCase() : '.mp4';
    const rel = `videos/${it.id}${ext}`;
    const dest = path.join(mediaOut, rel);
    const want = `${it.size}:${it.mtime}`;
    if (state.videos[it.id] === want && await exists(dest)) return rel;
    if (copyable(it)) {
      await place(it.path, dest);
    } else {
      const h264 = it.vcodec === 'h264' && /^yuvj?420p$/.test(it.pixfmt || '');
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', it.path, '-map', `0:${it.vindex}`];
      if (it.audio.length) args.push('-map', '0:a:0', ...(it.audio[0].codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '160k']));
      args.push(...(h264 ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p']));
      const tmp = `${dest}.tmp.mp4`;
      await run('ffmpeg', [...args, '-sn', '-dn', '-movflags', '+faststart', '-y', tmp]);
      await fsp.rename(tmp, dest);
      converted++;
    }
    state.videos[it.id] = want;
    return rel;
  }

  // Every audio track after the first becomes its own small file. With no server to re-cut
  // the video, the player plays the chosen one alongside the picture.
  async function otherAudio(it) {
    const want = `${it.size}:${it.mtime}`;
    const out = [];
    for (let n = 1; n < it.audio.length; n++) {
      const rel = `audio/${it.id}-${n}.m4a`;
      const dest = path.join(mediaOut, rel);
      if (state.audio[`${it.id}-${n}`] !== want || !(await exists(dest))) {
        const tmp = `${dest}.tmp.m4a`;
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', it.path, '-map', `0:a:${n}`, '-vn',
          ...(it.audio[n].codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '160k']), '-movflags', '+faststart', '-y', tmp]);
        await fsp.rename(tmp, dest);
        state.audio[`${it.id}-${n}`] = want;
      }
      out.push(rel);
    }
    return out;
  }

  // Small frames for the timeline's hover preview, made in one pass over the keyframes.
  async function previews(it) {
    const step = Math.max(10, Math.ceil(it.duration / 240));
    const dir = path.join(mediaOut, 'previews', it.id);
    if (state.previews[it.id] !== it.mtime || !(await exists(dir))) {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-i', it.path, '-map', `0:${it.vindex}`,
        '-vf', `fps=1/${step},scale=240:-2`, '-q:v', '6', '-y', path.join(dir, '%d.jpg')]);
      state.previews[it.id] = it.mtime;
    }
    return step;
  }

  let converted = 0;
  let done = 0;
  const failed = [];
  const limit = limiter(2);
  const published = await Promise.all(items.map((it) => limit(async () => {
    try {
      const view = catalog.itemView(tmdb, it, null, true);
      const [videoPath, extraAudio, previewStep, poster400, backdrop640, backdrop1920, frame640, logo] = await Promise.all([
        video(it), otherAudio(it).catch(() => []), previews(it).catch(() => 0),
        art(it, 'poster', 400), art(it, 'backdrop', 640), art(it, 'backdrop', 1920),
        it.type === 'episode' ? art(it, 'frame', 640) : null, art(it, 'logo'),
      ]);
      const subs = [];
      for (const s of view.subs) {
        try {
          await place(await media.subtitles(it, s.key), path.join(site, 'subs', `${it.id}-${s.key}.vtt`));
          subs.push(s);
        } catch { /* a subtitle track that cannot be read is left out */ }
      }
      process.stdout.write(`\r  ${++done} of ${items.length} videos ready`);
      return {
        ...view, subs, playback: 'direct',
        audio: view.audio.slice(0, 1 + extraAudio.length).map((a, n) => ({ ...a, url: n ? extraAudio[n - 1] : null })),
        video: videoPath, previewStep,
        art: { poster400, backdrop640, backdrop1920, frame640, logo },
      };
    } catch (err) {
      failed.push(`${path.basename(it.path)}: ${err.message}`);
      process.stdout.write(`\r  ${++done} of ${items.length} videos ready`);
      return null;
    }
  })));
  process.stdout.write('\n');
  const good = published.filter(Boolean);

  // Clear out videos and previews that belong to files no longer in the library.
  const keep = new Set(good.map((it) => it.id));
  let removed = 0;
  for (const sub of ['videos', 'previews', 'audio']) {
    for (const name of await fsp.readdir(path.join(mediaOut, sub))) {
      const id = name.slice(0, 16);
      if (/^[0-9a-f]{16}(\.|-|$)/.test(name) && !keep.has(id)) {
        await fsp.rm(path.join(mediaOut, sub, name), { recursive: true, force: true });
        removed += sub === 'videos' ? 1 : 0;
      }
    }
  }
  for (const part of [state.videos, state.previews, state.audio]) for (const id of Object.keys(part)) if (!keep.has(id.slice(0, 16))) delete part[id];
  writeJson(stateFile, state);

  for (const entry of await fsp.readdir(PUBLIC, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith('admin.')) await fsp.copyFile(path.join(PUBLIC, entry.name), path.join(site, entry.name)); // no admin page: this site is managed from the desktop
  }
  await fsp.writeFile(path.join(site, 'config.js'),
    `// Written by publish.js: this copy of SunFlix is a plain website with no server behind it.\nwindow.SUNFLIX_STATIC = true;\nwindow.SUNFLIX_MEDIA = ${JSON.stringify(mediaUrl || '/media')};\n`);
  await fsp.writeFile(path.join(site, 'library.json'), JSON.stringify({
    static: true, guest: true, publishedAt: Date.now(),
    items: good, continue: [], shows: catalog.showViews(tmdb, items),
    status: { scanning: false }, metadata: tmdb ? { busy: false } : null, mediaDirs: [],
  }));

  console.log(`Published ${good.length} videos${converted ? ` (${converted} converted to MP4)` : ''}${removed ? `, removed ${removed} that are gone` : ''}.`);
  if (failed.length) console.log(`Could not publish ${failed.length}:\n${failed.map((f) => `  ${f}`).join('\n')}`);
  console.log(`\n  Pages:  ${site}\n  Videos: ${mediaOut}\n`);
  if (mediaUrl) console.log(`Upload the videos folder so it is served at ${mediaUrl}, then put the pages folder on Netlify.`);
  else console.log(`No --media-url given, so the pages expect the videos at /media on the same site.\nTry it here with:  node publish.js --serve ${out}`);
  if (failed.length) process.exitCode = 1;
}

if (serveDir !== null) {
  if (!serveDir || !fs.existsSync(path.join(serveDir, 'site', 'index.html'))) fail('Usage: node publish.js --serve <folder made by publish>');
  serve(serveDir);
} else {
  if (!outArg || !argv.length) fail('Usage: node publish.js <media folders…> --out <folder> [--media-url https://where-the-videos-will-be]');
  if (mediaUrl && !/^https:\/\//.test(mediaUrl)) fail('--media-url has to start with https://');
  publish(argv.map((d) => path.resolve(d)), path.resolve(outArg)).catch((err) => fail(`Publish failed: ${err.message}`));
}
