'use strict';
// The back end of the "plain website" version of SunFlix, where videos are dragged onto an
// admin page instead of being scanned from a computer. It runs as a serverless function
// (netlify/functions/api.js) and does three things:
//   - serves the library list, which lives in the storage bucket as library.json
//   - gives the signed-in admin's browser addresses to upload a video straight to the bucket
//   - files each finished upload in the library, with TMDB details when a key is set
// The video bytes never pass through here.
const crypto = require('node:crypto');
const { S3 } = require('./s3');
const { parseMedia } = require('./parse');
const { pickMatch } = require('./tmdb');

const VIDEO_KEY = /^videos\/[0-9a-f]{16}\.(mp4|m4v|webm)$/;
const PART_SIZE = 16 * 1024 * 1024;
const MAX_SUBS = 8; // subtitle files per video
const MAX_AUDIO = 6; // extra audio-language files per video
const AUDIO_EXT = /^\.(m4a|mp3)$/;
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };

function config(env) {
  const need = ['SUNFLIX_ADMIN_PASSWORD', 'SUNFLIX_MEDIA_URL', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = need.filter((n) => !env[n]);
  const endpoint = env.S3_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  if (!endpoint) missing.push('R2_ACCOUNT_ID (or S3_ENDPOINT)');
  if (missing.length) throw Object.assign(new Error(`The site is not set up yet. Missing settings: ${missing.join(', ')}`), { status: 503 });
  return {
    s3: new S3({ endpoint, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, region: env.S3_REGION }),
    mediaUrl: env.SUNFLIX_MEDIA_URL.replace(/\/+$/, ''),
    password: env.SUNFLIX_ADMIN_PASSWORD,
    tmdbKey: (env.TMDB_API_KEY || '').trim(),
    tmdbUrl: (env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, ''),
  };
}

const emptyLibrary = () => ({ static: true, guest: true, items: [], shows: {}, continue: [], status: { scanning: false }, metadata: null, mediaDirs: [] });

async function readLibrary(s3) {
  const text = await s3.get('library.json');
  return text ? { ...emptyLibrary(), ...JSON.parse(text) } : emptyLibrary();
}

function sameSecret(a, b) {
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// ---------------------------------------------------------------------- TMDB

async function tmdbGet(cfg, pathname, params = {}) {
  const url = new URL(cfg.tmdbUrl + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  if (cfg.tmdbKey.length > 60) headers.Authorization = `Bearer ${cfg.tmdbKey}`; else url.searchParams.set('api_key', cfg.tmdbKey);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  return res.ok ? res.json() : null;
}

const image = (size, p) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

// Details for a movie or a show. Images stay on TMDB's image servers and are linked to.
async function lookUp(cfg, tv, name, year, pinnedId) {
  const kind = tv ? 'tv' : 'movie';
  const [nameKey, dateKey] = tv ? ['name', 'first_air_date'] : ['title', 'release_date'];
  let id = pinnedId;
  if (!id) {
    const yearParam = tv ? 'first_air_date_year' : 'year';
    let found = await tmdbGet(cfg, `/search/${kind}`, { query: name, [yearParam]: year });
    let hit = pickMatch(found && found.results, name, year, nameKey, dateKey);
    if (!hit && year) {
      found = await tmdbGet(cfg, `/search/${kind}`, { query: name });
      hit = pickMatch(found && found.results, name, year, nameKey, dateKey);
    }
    id = hit && hit.id;
  }
  const d = id && await tmdbGet(cfg, `/${kind}/${id}`, { append_to_response: 'credits,images', include_image_language: 'en,null' });
  if (!d) return null;
  const logos = (d.images && d.images.logos) || [];
  const logo = logos.find((l) => l.iso_639_1 === 'en' && /\.png$/i.test(l.file_path)) || logos.find((l) => /\.png$/i.test(l.file_path));
  const crew = (d.credits && d.credits.crew) || [];
  return {
    tmdbId: d.id, title: d[nameKey], year: Number(String(d[dateKey] || '').slice(0, 4)) || null,
    overview: d.overview || '', tagline: d.tagline || '',
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_count >= 10 ? Math.round(d.vote_average * 10) / 10 : null,
    cast: ((d.credits && d.credits.cast) || []).slice(0, 8).map((c) => c.name),
    directors: tv ? undefined : crew.filter((c) => c.job === 'Director').map((c) => c.name),
    creators: tv ? (d.created_by || []).map((c) => c.name) : undefined,
    poster: image('w500', d.poster_path), backdrop: image('w1280', d.backdrop_path), logo: image('w500', logo && logo.file_path),
  };
}

// ------------------------------------------------------------------- uploads

// Files a finished upload in the library and returns the new entry.
async function addToLibrary(cfg, lib, b) {
  const parsed = parseMedia(`/${String(b.path).replace(/\\/g, '/').replace(/^\/+/, '')}`);
  const id = b.key.slice(7, 23);
  const thumb = b.hasThumb ? `${cfg.mediaUrl}/thumbs/${id}.jpg` : null;
  const isEp = parsed.type === 'episode';
  const extraAudio = (Array.isArray(b.audio) ? b.audio : []).slice(0, MAX_AUDIO).filter((a) => a && AUDIO_EXT.test(a.ext))
    .map((a, n) => ({ lang: (typeof a.lang === 'string' && a.lang.slice(0, 12)) || null, title: null, url: `audio/${id}-${n + 1}${a.ext}` }));
  const item = {
    id, type: parsed.type, title: parsed.title, year: parsed.year,
    show: isEp ? parsed.show : undefined, showKey: parsed.showKey, season: parsed.season, episode: parsed.episode,
    overview: '', hasLogo: false, hasPoster: false, hasBackdrop: Boolean(thumb),
    duration: Number(b.duration) || 0, width: Number(b.width) || 0, height: Number(b.height) || 0,
    vcodec: '', size: Number(b.size) || 0, addedAt: Date.now(), playback: 'direct',
    // The video's own sound first, then any audio files that were dropped alongside it.
    audio: extraAudio.length ? [{ lang: null, title: 'Original', url: null }, ...extraAudio] : [],
    subs: (Array.isArray(b.subs) ? b.subs : []).slice(0, MAX_SUBS).map((s, n) => ({ key: `s${n}`, lang: (s && typeof s.lang === 'string' && s.lang.slice(0, 12)) || null, title: null, url: `/api/library?sub=${id}-s${n}` })),
    position: 0, watched: false,
    video: b.key,
    sprite: b.sprite ? { url: `${cfg.mediaUrl}/sprites/${id}.jpg`, cols: Number(b.sprite.cols), step: Number(b.sprite.step), count: Number(b.sprite.count), w: Number(b.sprite.w), h: Number(b.sprite.h) } : null,
    art: { poster400: null, backdrop640: thumb, backdrop1920: thumb, frame640: thumb, logo: null },
  };

  if (cfg.tmdbKey) {
    try {
      if (!isEp) {
        const m = await lookUp(cfg, false, parsed.title, parsed.year, parsed.tmdbId);
        if (m) {
          Object.assign(item, { title: m.title, year: m.year || item.year, overview: m.overview, tagline: m.tagline, genres: m.genres, rating: m.rating, cast: m.cast, directors: m.directors });
          Object.assign(item.art, { poster400: m.poster, backdrop640: m.backdrop || thumb, backdrop1920: m.backdrop || thumb, logo: m.logo });
        }
      } else {
        // A show is looked up once, when its first episode arrives; later episodes reuse it.
        let show = lib.shows[parsed.showKey];
        if (!show) {
          const m = await lookUp(cfg, true, parsed.show, parsed.year, parsed.tmdbId);
          show = m || { missing: true };
          lib.shows[parsed.showKey] = show;
        }
        if (!show.missing) {
          Object.assign(item, { show: show.title, year: show.year || item.year });
          Object.assign(item.art, { poster400: show.poster, backdrop640: show.backdrop || thumb, backdrop1920: show.backdrop || thumb, logo: show.logo });
          const season = await tmdbGet(cfg, `/tv/${show.tmdbId}/season/${parsed.season}`);
          const ep = ((season && season.episodes) || []).find((e) => e.episode_number === parsed.episode);
          if (ep) Object.assign(item, { title: ep.name || item.title, overview: ep.overview || '' });
        }
      }
    } catch { /* TMDB being slow or down must never lose an upload */ }
    lib.metadata = { busy: false };
  }
  item.hasPoster = Boolean(item.art.poster400);
  item.hasLogo = Boolean(item.art.logo);
  item.hasBackdrop = Boolean(item.art.backdrop640);

  lib.items = lib.items.filter((it) => it.id !== id).concat(item);
  return item;
}

async function admin(cfg, b) {
  const { s3 } = cfg;
  const str = (v) => (typeof v === 'string' ? v : '');
  const key = str(b.key);
  const needKey = () => { if (!VIDEO_KEY.test(key)) throw Object.assign(new Error('Unknown upload.'), { status: 400 }); };

  switch (b.action) {
    case 'check':
      return { ok: true, tmdb: Boolean(cfg.tmdbKey) };

    case 'start': {
      const rel = str(b.path);
      const ext = (/\.[a-z0-9]+$/i.exec(rel) || [''])[0].toLowerCase();
      if (!TYPES[ext]) throw Object.assign(new Error('Only MP4 and WebM videos can be uploaded here.'), { status: 400 });
      const id = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
      const newKey = `videos/${id}${ext}`;
      return { id, key: newKey, uploadId: await s3.startUpload(newKey, TYPES[ext]), partSize: PART_SIZE };
    }

    case 'parts': {
      needKey();
      const numbers = (Array.isArray(b.numbers) ? b.numbers : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10000).slice(0, 100);
      return { urls: numbers.map((n) => ({ n, url: s3.partUrl(key, str(b.uploadId), n) })) };
    }

    // Small companions of a video: its still frame, preview sheet and subtitle file.
    case 'sign': {
      const id = str(b.id);
      const n = Number(b.n) || 0;
      const audioExt = AUDIO_EXT.test(str(b.ext)) ? b.ext : '.m4a';
      const names = { thumb: `thumbs/${id}.jpg`, sprite: `sprites/${id}.jpg`, sub: `subs/${id}-s${n}.vtt`, audio: `audio/${id}-${n + 1}${audioExt}` };
      const limit = b.kind === 'audio' ? MAX_AUDIO : MAX_SUBS;
      if (!/^[0-9a-f]{16}$/.test(id) || !names[b.kind] || !Number.isInteger(n) || n < 0 || n >= limit) throw Object.assign(new Error('Unknown file.'), { status: 400 });
      return { url: s3.presign('PUT', names[b.kind], {}, 3600) };
    }

    case 'finish': {
      needKey();
      await s3.finishUpload(key, str(b.uploadId), Array.isArray(b.parts) ? b.parts : []);
      const lib = await readLibrary(s3);
      const item = await addToLibrary(cfg, lib, b);
      lib.publishedAt = Date.now();
      await s3.put('library.json', JSON.stringify(lib), 'application/json');
      return { item };
    }

    case 'abort':
      needKey();
      await s3.abortUpload(key, str(b.uploadId));
      return { ok: true };

    case 'remove': {
      const lib = await readLibrary(s3);
      const item = lib.items.find((it) => it.id === b.id);
      if (!item) return { ok: true };
      lib.items = lib.items.filter((it) => it !== item);
      // Forget a show once its last episode is gone, so a re-upload looks it up afresh.
      if (item.showKey && !lib.items.some((it) => it.showKey === item.showKey)) delete lib.shows[item.showKey];
      await s3.put('library.json', JSON.stringify(lib), 'application/json');
      const subFiles = (item.subs || []).map((s) => `subs/${item.id}-${s.key}.vtt`);
      const audioFiles = (item.audio || []).map((a) => a.url).filter(Boolean);
      await Promise.all([item.video, `thumbs/${item.id}.jpg`, `sprites/${item.id}.jpg`, ...subFiles, ...audioFiles].map((k) => s3.remove(k).catch(() => {})));
      return { ok: true };
    }

    default:
      throw Object.assign(new Error('Unknown request.'), { status: 400 });
  }
}

// ------------------------------------------------------------------- handler

// One entry point: { method, path, query, headers, body } in, { status, headers, body } out.
async function handle(req, env = process.env) {
  const json = (status, body, headers = {}) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, body: JSON.stringify(body) });
  try {
    const cfg = config(env);
    const route = req.path.replace(/^.*\/api\//, '').replace(/\/+$/, '');

    if (route === 'library' && req.method === 'GET') {
      const sub = req.query && req.query.sub;
      if (sub) {
        if (!/^[0-9a-f]{16}-s\d$/.test(sub)) return json(404, { error: 'not found' });
        const vtt = await cfg.s3.get(`subs/${sub}.vtt`);
        return vtt == null ? json(404, { error: 'not found' })
          : { status: 200, headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body: vtt };
      }
      // Viewers may see a list that is up to half a minute old; the admin page asks for a fresh one.
      return json(200, await readLibrary(cfg.s3), { 'Cache-Control': req.query && req.query.fresh ? 'no-store' : 'public, max-age=30' });
    }

    if (route === 'admin' && req.method === 'POST') {
      const given = /^Bearer (.+)$/.exec((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
      if (!given || !sameSecret(given[1], cfg.password)) return json(401, { error: 'Wrong password.' });
      let body;
      try { body = JSON.parse(req.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
      return json(200, await admin(cfg, body));
    }
    return json(404, { error: 'not found' });
  } catch (err) {
    return json(err.status || 500, { error: err.status ? err.message : `Something went wrong: ${err.message}` });
  }
}

module.exports = { handle };
