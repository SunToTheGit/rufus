'use strict';
// Looks titles up on The Movie Database (TMDB) and keeps what it finds in
// data/metadata.json, with artwork in data/tmdb/. Only runs when the user
// has set TMDB_API_KEY, and only sends titles and years, never file names.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { limiter, readJson, writeJson } = require('./library');
const { slug } = require('./parse');

const RETRY_MISS_AFTER = 7 * 86400000; // look again for unmatched titles after a week
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Which search result is the title on disk? Exact name and matching year win; a loose
// name match is accepted, anything else is treated as "not found" rather than guessed.
function pickMatch(results, title, year, nameKey, dateKey) {
  const q = norm(title);
  const words = new Set(q.split(' '));
  let best = null;
  let bestScore = 1;
  (results || []).slice(0, 10).forEach((r, i) => {
    const names = [norm(r[nameKey]), norm(r[`original_${nameKey}`])].filter(Boolean);
    let score;
    if (names.includes(q)) score = 3;
    else if (names.some((n) => n.startsWith(q) || q.startsWith(n))) score = 1.5;
    else {
      const other = names[0] ? names[0].split(' ') : [];
      const shared = other.filter((w) => words.has(w)).length;
      if (!other.length || shared / Math.max(other.length, words.size) < 0.6) return;
      score = 1;
    }
    const y = Number(String(r[dateKey] || '').slice(0, 4));
    if (year && y) score += y === year ? 2 : Math.abs(y - year) === 1 ? 1 : -1;
    score -= i * 0.01; // TMDB's own ordering breaks ties
    if (score >= bestScore) { best = r; bestScore = score + 0.001; }
  });
  return best;
}

class Tmdb {
  constructor({ key, dataDir, apiUrl, imageUrl }) {
    this.key = key;
    this.bearer = key.length > 60; // v4 "read access token"; the short v3 key goes in the query string
    this.apiUrl = (apiUrl || 'https://api.themoviedb.org/3').replace(/\/$/, '');
    this.imageUrl = (imageUrl || 'https://image.tmdb.org/t/p').replace(/\/$/, '');
    this.file = path.join(dataDir, 'metadata.json');
    this.imgDir = path.join(dataDir, 'tmdb');
    fs.mkdirSync(this.imgDir, { recursive: true });
    this.entries = readJson(this.file, {}).entries || {};
    this.status = { busy: false, done: 0, total: 0, error: null };
    this.running = null;
  }

  keyFor(item) {
    const kind = item.type === 'movie' ? 'movie' : 'tv';
    if (item.tmdbId) return `${kind}:id:${item.tmdbId}`;
    return item.type === 'movie' ? `movie:${slug(item.title)}:${item.year || ''}` : `tv:${item.showKey}`;
  }

  // Metadata for a library item, or null when there is none (yet).
  for(item) {
    const e = this.entries[this.keyFor(item)];
    return e && e.found ? e : null;
  }

  // Looks up every title that has not been looked up yet. Safe to call after each scan.
  sync(items) {
    if (!this.running) {
      this.running = this._sync(items)
        .catch((err) => { this.status.error = err.message; console.error(`[tmdb] ${err.message}`); })
        .finally(() => { this.status.busy = false; this.running = null; });
    }
    return this.running;
  }

  async _sync(items) {
    const titles = new Map();
    for (const it of items) {
      const key = this.keyFor(it);
      if (!titles.has(key)) {
        titles.set(key, { key, tv: it.type !== 'movie', name: it.type === 'movie' ? it.title : it.show, year: it.year, id: it.tmdbId, seasons: new Set() });
      }
      if (it.type !== 'movie') titles.get(key).seasons.add(it.season);
    }
    const todo = [...titles.values()].filter((t) => {
      const e = this.entries[t.key];
      if (!e) return true;
      if (!e.found) return Date.now() - e.at > RETRY_MISS_AFTER;
      return t.tv && [...t.seasons].some((n) => !(e.seasonsFetched || []).includes(n));
    });
    Object.assign(this.status, { busy: todo.length > 0, done: 0, total: todo.length, error: null });
    if (!todo.length) return;

    const limit = limiter(3);
    const missed = [];
    const failed = [];
    let fatal = null;
    await Promise.all(todo.map((t) => limit(async () => {
      if (fatal) return;
      try {
        const entry = await (t.tv ? this._show(t) : this._movie(t));
        this.entries[t.key] = entry;
        if (!entry.found) missed.push(t.name);
      } catch (err) {
        if (err.fatal) fatal = err; else failed.push(t.name); // left unsaved, so the next scan tries again
      }
      this.status.done++;
    })));
    writeJson(this.file, { entries: this.entries });
    if (fatal) throw fatal;
    console.log(`[tmdb] matched ${todo.length - missed.length - failed.length} of ${todo.length} titles`
      + (missed.length ? `; no match for: ${missed.join(', ')}` : '')
      + (failed.length ? `; could not reach TMDB for ${failed.length}, will retry on the next scan` : ''));
    if (failed.length) this.status.error = 'Could not reach TMDB for some titles.';
  }

  async _get(pathname, params = {}) {
    const url = new URL(this.apiUrl + pathname);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
    const headers = { Accept: 'application/json' };
    if (this.bearer) headers.Authorization = `Bearer ${this.key}`; else url.searchParams.set('api_key', this.key);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (res.status === 401) throw Object.assign(new Error('TMDB rejected the API key. Check TMDB_API_KEY.'), { fatal: true });
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
      return res.json();
    }
  }

  // Saves one TMDB image locally and returns its path, or null if there is none.
  async _image(tmdbPath, size, name) {
    if (!tmdbPath) return null;
    const out = path.join(this.imgDir, name + path.extname(tmdbPath).toLowerCase());
    try { await fsp.access(out); return out; } catch { /* not downloaded yet */ }
    try {
      const res = await fetch(`${this.imageUrl}/${size}${tmdbPath}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      await fsp.writeFile(`${out}.tmp`, Buffer.from(await res.arrayBuffer()));
      await fsp.rename(`${out}.tmp`, out);
      return out;
    } catch {
      return null;
    }
  }

  async _common(kind, d) {
    const logos = (d.images && d.images.logos) || [];
    const logo = logos.find((l) => l.iso_639_1 === 'en' && /\.png$/i.test(l.file_path)) || logos.find((l) => /\.png$/i.test(l.file_path));
    const [poster, backdrop, logoFile] = await Promise.all([
      this._image(d.poster_path, 'w780', `${kind}-${d.id}-poster`),
      this._image(d.backdrop_path, 'w1280', `${kind}-${d.id}-backdrop`),
      this._image(logo && logo.file_path, 'w500', `${kind}-${d.id}-logo`),
    ]);
    return {
      found: true, at: Date.now(), tmdbId: d.id,
      overview: d.overview || '', tagline: d.tagline || '',
      genres: (d.genres || []).map((g) => g.name),
      rating: d.vote_count >= 10 ? Math.round(d.vote_average * 10) / 10 : null,
      cast: ((d.credits && d.credits.cast) || []).slice(0, 8).map((c) => c.name),
      poster, backdrop, logo: logoFile,
    };
  }

  async _movie(t) {
    let id = t.id;
    if (!id) {
      let found = await this._get('/search/movie', { query: t.name, year: t.year });
      let hit = pickMatch(found && found.results, t.name, t.year, 'title', 'release_date');
      if (!hit && t.year) { // the year in a file name is often off by one, or a re-release date
        found = await this._get('/search/movie', { query: t.name });
        hit = pickMatch(found && found.results, t.name, t.year, 'title', 'release_date');
      }
      id = hit && hit.id;
    }
    const d = id && await this._get(`/movie/${id}`, { append_to_response: 'credits,images', include_image_language: 'en,null' });
    if (!d) return { found: false, at: Date.now() };
    const crew = (d.credits && d.credits.crew) || [];
    return {
      ...(await this._common('movie', d)),
      title: d.title, year: Number(String(d.release_date || '').slice(0, 4)) || null,
      directors: crew.filter((c) => c.job === 'Director').map((c) => c.name),
    };
  }

  async _show(t) {
    const old = this.entries[t.key];
    let id = t.id || (old && old.found && old.tmdbId);
    if (!id) {
      let found = await this._get('/search/tv', { query: t.name, first_air_date_year: t.year });
      let hit = pickMatch(found && found.results, t.name, t.year, 'name', 'first_air_date');
      if (!hit && t.year) {
        found = await this._get('/search/tv', { query: t.name });
        hit = pickMatch(found && found.results, t.name, t.year, 'name', 'first_air_date');
      }
      id = hit && hit.id;
    }
    const d = id && await this._get(`/tv/${id}`, { append_to_response: 'credits,images', include_image_language: 'en,null' });
    if (!d) return { found: false, at: Date.now() };
    const entry = {
      ...(await this._common('tv', d)),
      title: d.name, year: Number(String(d.first_air_date || '').slice(0, 4)) || null,
      creators: (d.created_by || []).map((c) => c.name),
      episodes: {}, seasonsFetched: [],
    };
    for (const n of [...t.seasons].sort((a, b) => a - b)) {
      const season = await this._get(`/tv/${id}/season/${n}`);
      for (const ep of (season && season.episodes) || []) {
        entry.episodes[`${n}x${ep.episode_number}`] = { title: ep.name || '', overview: ep.overview || '' };
      }
      entry.seasonsFetched.push(n);
    }
    return entry;
  }
}

module.exports = { Tmdb, pickMatch };
