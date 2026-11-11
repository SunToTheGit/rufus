'use strict';
/* SunFlix admin page: drag videos in, they upload straight to the storage bucket.
   Nothing on your computer is scanned; only the files you drop are read. */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const PLAYABLE = ['.mp4', '.m4v', '.webm'];
const OTHER_VIDEO = ['.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv']; // converted before they upload
const SUBS = ['.srt', '.vtt'];
const AUDIO = ['.m4a', '.mp3']; // another language for a video, named like it: Movie.fr.m4a
const ext = (name) => (/\.[a-z0-9]+$/i.exec(name) || [''])[0].toLowerCase();
const stem = (name) => name.slice(0, name.length - ext(name).length);
const sizeText = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

let password = '';
try { password = sessionStorage.getItem('sunflix-admin') || ''; } catch { /* private mode */ }

async function call(body) {
  const res = await fetch('/api/admin', { method: 'POST', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { lock(); throw new Error('Wrong password.'); }
  if (!res.ok) throw new Error(data.error || `The site answered ${res.status}.`);
  return data;
}

// ------------------------------------------------------------------- sign-in

function lock() {
  password = '';
  try { sessionStorage.removeItem('sunflix-admin'); } catch { /* private mode */ }
  $('panel').hidden = true;
  $('lock').hidden = true;
  $('gate').hidden = false;
  $('password').focus();
}

async function unlock(candidate) {
  password = candidate;
  await call({ action: 'check' });
  try { sessionStorage.setItem('sunflix-admin', password); } catch { /* private mode */ }
  $('gate').hidden = true;
  $('panel').hidden = false;
  $('lock').hidden = false;
  showLibrary();
}

$('gate').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gate-error').textContent = '';
  try { await unlock($('password').value); } catch (err) { $('gate-error').textContent = err.message; }
});
$('lock').addEventListener('click', lock);

// ------------------------------------------------------------------- library

async function showLibrary() {
  const lib = await fetch('/api/library?fresh=1', { cache: 'no-store' }).then((r) => r.json());
  const list = $('library');
  list.replaceChildren();
  $('count').textContent = lib.items.length ? String(lib.items.length) : '';
  if (!lib.items.length) { list.append(el('span', 'none', 'Nothing yet. Videos you add appear here.')); return; }
  const label = (it) => (it.type === 'episode' ? `${it.show} · S${it.season} E${it.episode} · ${it.title}` : `${it.title}${it.year ? ` (${it.year})` : ''}`);
  for (const it of [...lib.items].sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }))) {
    const row = el('li');
    const src = it.art && (it.art.frame640 || it.art.backdrop640);
    const pic = src ? el('img') : el('div', 'noimg');
    if (src) { pic.src = src; pic.alt = ''; pic.loading = 'lazy'; }
    const text = el('div');
    text.append(el('div', 't', label(it)), el('div', 's', [sizeText(it.size), it.subs.length ? `${it.subs.length} subtitle${it.subs.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')));
    const remove = el('button', '', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Remove “${label(it)}” from the site? The uploaded video is deleted.`)) return;
      remove.disabled = true;
      remove.textContent = 'Removing…';
      try { await call({ action: 'remove', id: it.id }); row.remove(); } catch (err) { remove.disabled = false; remove.textContent = 'Remove'; window.alert(err.message); }
    });
    row.append(pic, text, remove);
    list.append(row);
  }
}

// ------------------------------------------------------------ reading a video

const once = (target, name, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error('timed out')); }, ms);
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(new Error('cannot be read')); };
  function cleanup() { clearTimeout(timer); target.removeEventListener(name, ok); target.removeEventListener('error', bad); }
  target.addEventListener(name, ok);
  target.addEventListener('error', bad);
});

const toJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

// Opens the file in this browser to learn its length and size, and to draw the still frame
// and the sheet of preview frames. If the browser cannot play it, neither can visitors.
async function inspect(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  try {
    await once(video, 'loadedmetadata', 30000);
    if (!video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0) throw new Error('no picture');
    const { duration, videoWidth: w, videoHeight: h } = video;
    const seek = async (t) => { video.currentTime = Math.min(Math.max(0, t), Math.max(0, duration - 0.1)); await once(video, 'seeked', 15000); };

    const still = document.createElement('canvas');
    still.width = Math.min(1280, w);
    still.height = Math.round(still.width * h / w);
    await seek(duration * 0.1);
    still.getContext('2d').drawImage(video, 0, 0, still.width, still.height);
    const thumb = await toJpeg(still, 0.82);

    let sprite = null;
    try {
      const count = Math.max(1, Math.min(100, Math.floor(duration / 5)));
      const step = duration / count;
      const cols = 10;
      const cw = 160;
      const ch = Math.round(cw * h / w / 2) * 2;
      const sheet = document.createElement('canvas');
      sheet.width = cols * cw;
      sheet.height = Math.ceil(count / cols) * ch;
      const ctx = sheet.getContext('2d');
      for (let i = 0; i < count; i++) {
        await seek(i * step + Math.min(step / 2, 1));
        ctx.drawImage(video, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
      }
      sprite = { blob: await toJpeg(sheet, 0.6), cols, step, count, w: cw, h: ch };
    } catch { /* previews are a nicety; the upload goes ahead without them */ }

    return { duration, width: w, height: h, thumb, sprite };
  } finally {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
}

// ----------------------------------------------------------------- converting

// A build of ffmpeg that runs inside this page. The Netlify build puts it in /vendor/ffmpeg;
// when it is not there the page still works, but only for files browsers already play.
const VENDOR = '/vendor/ffmpeg';
const CONVERT_LIMIT = 2e9; // the converted file is held in memory before it uploads
const TEXT_SUBS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
let converterScript = null;
function converterAvailable() {
  if (!converterScript) {
    converterScript = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = `${VENDOR}/ffmpeg.js`;
      s.onload = () => resolve(Boolean(window.FFmpegWASM));
      s.onerror = () => resolve(false);
      document.head.append(s);
    });
  }
  return converterScript;
}

// Looks inside the file; converts it if browsers cannot play it; pulls out any subtitles and
// extra audio languages stored inside it. Returns what to upload and what was found.
async function convert(file, say, onProgress) {
  const ff = new window.FFmpegWASM.FFmpeg();
  await ff.load({ coreURL: `${VENDOR}/ffmpeg-core.js`, wasmURL: `${VENDOR}/ffmpeg-core.wasm` });
  try {
    await ff.createDir('/in');
    await ff.mount('WORKERFS', { files: [file] }, '/in');
    const input = `/in/${file.name}`;
    await ff.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input, '-o', 'probe.json']);
    const probe = JSON.parse(new TextDecoder().decode(await ff.readFile('probe.json')));
    const streams = probe.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (!video) throw new Error('There is no video in this file.');
    const audios = streams.filter((s) => s.codec_type === 'audio');
    const subs = streams.filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.includes(s.codec_name));
    const duration = parseFloat(probe.format && probe.format.duration) || 0;
    const lang = (s) => (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null;

    const container = ext(file.name);
    const eightBit = /^yuvj?420p$/.test(video.pix_fmt || '');
    const mp4Ready = ['.mp4', '.m4v'].includes(container) && video.codec_name === 'h264' && eightBit && (!audios[0] || ['aac', 'mp3'].includes(audios[0].codec_name));
    const webmReady = container === '.webm' && ['vp8', 'vp9', 'av1'].includes(video.codec_name) && (!audios[0] || ['opus', 'vorbis'].includes(audios[0].codec_name));
    const converting = !(mp4Ready || webmReady);
    // The picture is copied untouched whenever it is a kind browsers can show; only odd
    // formats are re-encoded, which is the slow part.
    const copyPicture = (video.codec_name === 'h264' && eightBit) || video.codec_name === 'hevc';
    if (converting && file.size > CONVERT_LIMIT) {
      throw new Error(`This file needs converting and is ${sizeText(file.size)}. Files over ${sizeText(CONVERT_LIMIT)} are too big to convert in a browser; convert it on your computer (HandBrake, or SunFlix's publish command) and drop the MP4.`);
    }

    const args = ['-hide_banner', '-i', input];
    if (converting) {
      args.push('-map', `0:${video.index}`);
      if (audios[0]) args.push('-map', `0:${audios[0].index}`, ...(audios[0].codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '160k']));
      if (copyPicture) args.push('-c:v', 'copy', ...(video.codec_name === 'hevc' ? ['-tag:v', 'hvc1'] : []));
      else args.push('-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-pix_fmt', 'yuv420p', ...(video.width > 1920 ? ['-vf', 'scale=1920:-2'] : []));
      args.push('-sn', '-dn', '-movflags', '+faststart', 'out.mp4');
    }
    subs.slice(0, 8).forEach((s, n) => args.push('-map', `0:${s.index}`, '-f', 'webvtt', `sub${n}.vtt`));
    audios.slice(1, 7).forEach((a, n) => args.push('-map', `0:${a.index}`, '-vn', ...(a.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '160k']), `audio${n}.m4a`));

    let output = file;
    const foundSubs = [];
    const foundAudio = [];
    if (args.length > 3) {
      say(converting ? (copyPicture ? 'Converting…' : 'Converting (re-encoding the picture, this is slow)…') : 'Reading subtitles and audio…');
      ff.on('progress', (e) => { if (e.progress >= 0 && e.progress <= 1) onProgress(e.progress, converting); });
      const code = await ff.exec(args);
      if (code !== 0) throw new Error('This file could not be converted. It may be damaged or use a format that is not supported.');
      if (converting) output = new File([await ff.readFile('out.mp4')], `${stem(file.name)}.mp4`, { type: 'video/mp4' });
      for (let n = 0; n < Math.min(subs.length, 8); n++) foundSubs.push({ file: new Blob([await ff.readFile(`sub${n}.vtt`)], { type: 'text/vtt' }), lang: lang(subs[n]) });
      for (let n = 0; n < Math.min(audios.length - 1, 6); n++) foundAudio.push({ file: new Blob([await ff.readFile(`audio${n}.m4a`)], { type: 'audio/mp4' }), lang: lang(audios[n + 1]), ext: '.m4a' });
    }

    // Still frame and preview sheet: drawn by the browser when it can play the result, and by
    // the converter when it cannot (HEVC on a browser without it, for instance).
    let info;
    try { info = await inspect(output); } catch {
      const w = video.width;
      const h = video.height;
      const source = converting ? 'out.mp4' : input;
      await ff.exec(['-ss', String(duration * 0.1), '-i', source, '-frames:v', '1', '-vf', `scale=${Math.min(1280, w)}:-2`, '-q:v', '4', 'still.jpg']);
      const thumb = new Blob([await ff.readFile('still.jpg')], { type: 'image/jpeg' });
      let sprite = null;
      try {
        const count = Math.max(1, Math.min(100, Math.floor(duration / 5)));
        const step = duration / count;
        const cw = 160;
        const ch = Math.round(cw * h / w / 2) * 2;
        await ff.exec(['-skip_frame', 'nokey', '-i', source, '-vf', `fps=1/${step},scale=${cw}:${ch},tile=10x${Math.ceil(count / 10)}`, '-frames:v', '1', '-q:v', '6', 'sheet.jpg']);
        sprite = { blob: new Blob([await ff.readFile('sheet.jpg')], { type: 'image/jpeg' }), cols: 10, step, count, w: cw, h: ch };
      } catch { /* previews are a nicety */ }
      info = { duration, width: w, height: h, thumb, sprite };
    }
    return { file: output, converted: converting, info, subs: foundSubs, audio: foundAudio, hevc: video.codec_name === 'hevc' };
  } finally {
    ff.terminate(); // hands the memory back
  }
}

// What to upload for a dropped video, with or without the converter.
async function prepare(file, say, onProgress) {
  if (await converterAvailable()) return convert(file, say, onProgress);
  if (!PLAYABLE.includes(ext(file.name))) {
    throw new Error(`${ext(file.name).slice(1).toUpperCase()} files do not play in browsers, and this site was built without its converter. Convert it to MP4 (H.264 video, AAC audio) and drop it again.`);
  }
  try { return { file, converted: false, info: await inspect(file), subs: [], audio: [] }; } catch {
    throw new Error('This browser cannot play this file, so it would not play on the site either. Convert it to MP4 (H.264 video, AAC audio) and drop it again.');
  }
}

// ------------------------------------------------------------------ uploading

function putBlob(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader('ETag')) : reject(new Error(`storage answered ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('the connection dropped'));
    xhr.send(blob);
  });
}

async function withRetries(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
}

// Sends the file to the bucket in parts, three at a time, retrying a part that fails.
async function uploadVideo(file, up, onProgress) {
  const total = Math.max(1, Math.ceil(file.size / up.partSize));
  const sent = new Array(total + 1).fill(0);
  const parts = [];
  let next = 1;
  let urls = new Map();
  async function urlFor(n) {
    if (!urls.has(n)) {
      const numbers = [];
      for (let i = n; i <= total && numbers.length < 50; i++) numbers.push(i);
      const res = await call({ action: 'parts', key: up.key, uploadId: up.uploadId, numbers });
      urls = new Map(res.urls.map((u) => [u.n, u.url]));
    }
    return urls.get(n);
  }
  async function worker() {
    while (next <= total) {
      const n = next++;
      const blob = file.slice((n - 1) * up.partSize, n * up.partSize);
      const etag = await withRetries(async () => putBlob(await urlFor(n), blob, (loaded) => {
        sent[n] = loaded;
        onProgress(sent.reduce((a, b) => a + b, 0) / Math.max(1, file.size));
      }));
      if (!etag) throw new Error('the bucket is not set up to allow uploads from this site (its CORS rules must expose the ETag header)');
      parts.push({ n, etag });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return parts.sort((a, b) => a.n - b.n);
}

const toVtt = (text) => (/^\uFEFF?WEBVTT/.test(text) ? text : `WEBVTT\n\n${text.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`);

async function addVideo(job) {
  const { file, path, subs, audio, row } = job;
  const say = (state, note) => { row.state.textContent = state; if (note != null) row.note.textContent = note; };
  let up = null;
  try {
    say('Checking…');
    const ready = await prepare(file, say, (f, converting) => { row.bar.style.width = `${Math.round(f * 100)}%`; if (converting) say(`Converting ${Math.round(f * 100)}%`); });
    const { info } = ready;
    const upload = ready.file;
    const uploadPath = ready.converted ? `${stem(path)}.mp4` : path;
    const allSubs = [...subs, ...ready.subs]; // files dropped alongside, then ones found inside the video
    const allAudio = [...audio, ...ready.audio];
    row.bar.style.width = '0%';
    up = await call({ action: 'start', path: uploadPath, size: upload.size });
    const parts = await uploadVideo(upload, up, (f) => { row.bar.style.width = `${Math.round(f * 100)}%`; say(`Uploading ${Math.round(f * 100)}%`); });

    say('Finishing…');
    const sendSmall = async (kind, blob, n, extra) => {
      const { url } = await call({ action: 'sign', id: up.id, kind, n, ...extra });
      await withRetries(() => putBlob(url, blob, () => {}));
    };
    await sendSmall('thumb', info.thumb);
    if (info.sprite) await sendSmall('sprite', info.sprite.blob);
    const subMeta = [];
    for (const s of allSubs.slice(0, 8)) {
      await sendSmall('sub', new Blob([toVtt(await s.file.text())], { type: 'text/vtt' }), subMeta.length);
      subMeta.push({ lang: s.lang });
    }
    const audioMeta = [];
    for (const a of allAudio.slice(0, 6)) {
      const kind = a.ext || ext(a.file.name);
      say(`Uploading audio (${a.lang || 'extra'})…`);
      await sendSmall('audio', a.file, audioMeta.length, { ext: kind });
      audioMeta.push({ lang: a.lang, ext: kind });
    }
    const { item } = await call({
      action: 'finish', key: up.key, uploadId: up.uploadId, parts, path: uploadPath, size: upload.size,
      duration: info.duration, width: info.width, height: info.height, hasThumb: true, subs: subMeta, audio: audioMeta,
      sprite: info.sprite ? { cols: info.sprite.cols, step: info.sprite.step, count: info.sprite.count, w: info.sprite.w, h: info.sprite.h } : null,
    });
    row.li.classList.add('done');
    const filed = item.type === 'episode' ? `${item.show}, season ${item.season} episode ${item.episode}` : `${item.title}${item.year ? ` (${item.year})` : ''}`;
    const extras = [subMeta.length ? `${subMeta.length} subtitle file${subMeta.length > 1 ? 's' : ''}` : null,
      audioMeta.length ? `${audioMeta.length} extra audio track${audioMeta.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' and ');
    const how = ready.converted ? ` Converted to MP4${ready.hevc ? ' (HEVC picture kept as it is: plays in Safari and most recent browsers, not on some older devices)' : ''}.` : '';
    say('Added', `Filed as ${filed}${extras ? `, with ${extras}` : ''}.${how}`);
  } catch (err) {
    if (up) call({ action: 'abort', key: up.key, uploadId: up.uploadId }).catch(() => {});
    row.li.classList.add('failed');
    say('Not added', err.message.charAt(0).toUpperCase() + err.message.slice(1));
  }
}

// ----------------------------------------------------------------- the queue

const queue = [];
let working = false;

function queueRow(name, size) {
  const li = el('li');
  const head = el('div', 'name');
  const state = el('span', 'state', 'Waiting');
  head.append(el('span', '', name), state);
  const meter = el('div', 'meter');
  const bar = el('i');
  meter.append(bar);
  const note = el('div', 'note', size ? sizeText(size) : '');
  li.append(head, meter, note);
  $('queue').append(li);
  return { li, state, bar, note };
}

async function work() {
  if (working) return;
  working = true;
  while (queue.length) await addVideo(queue.shift());
  working = false;
  showLibrary().catch(() => {});
}

// Takes whatever was dropped or picked: videos are queued, subtitles ride along with the
// video that shares their name, anything else is ignored.
function take(entries) {
  const videos = entries.filter((e) => PLAYABLE.includes(ext(e.path)) || OTHER_VIDEO.includes(ext(e.path)));
  const subs = entries.filter((e) => SUBS.includes(ext(e.path)));
  const sounds = entries.filter((e) => AUDIO.includes(ext(e.path)));
  for (const v of videos) {
    const base = stem(v.path);
    const companions = (list) => list.filter((s) => stem(s.path) === base || s.path.startsWith(`${base}.`))
      .map((s) => ({ file: s.file, lang: stem(s.path).slice(base.length + 1) || null }));
    queue.push({ ...v, subs: companions(subs), audio: companions(sounds), row: queueRow(v.path, v.file.size) });
  }
  if (!videos.length) {
    const row = queueRow('Nothing to add');
    row.li.classList.add('failed');
    row.state.textContent = '';
    row.note.textContent = 'No videos were found in what you dropped.';
  }
  work();
}

// Walks dropped folders so "Show/Season 1/…" keeps its shape, which is how episodes get sorted.
async function fromDrop(dataTransfer) {
  const out = [];
  const roots = [...dataTransfer.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!roots.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: prefix + file.name });
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  }
  for (const root of roots) await walk(root, '');
  return out;
}

const drop = $('drop');
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', async (e) => take(await fromDrop(e.dataTransfer)));
// A file dropped beside the box would otherwise make the browser navigate away to it.
for (const name of ['dragover', 'drop']) window.addEventListener(name, (e) => e.preventDefault());

const picked = (input) => { take([...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); input.value = ''; };
$('pick-files').addEventListener('click', () => $('files').click());
$('pick-folder').addEventListener('click', () => $('folder').click());
$('files').addEventListener('change', () => picked($('files')));
$('folder').addEventListener('change', () => picked($('folder')));

window.addEventListener('beforeunload', (e) => { if (working) { e.preventDefault(); e.returnValue = ''; } });

if (password) unlock(password).catch(lock); else lock();
