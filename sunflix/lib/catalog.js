'use strict';
// Turns scanned library items into what the web app is given. Shared by the server and
// by publish.js, which writes the same thing to a file for the static site.
const path = require('node:path');

// Artwork next to the files wins; TMDB fills the gaps.
function artSource(tmdb, it, kind) {
  const meta = tmdb && tmdb.for(it);
  if (kind === 'logo') return meta ? meta.logo : null;
  if (kind === 'frame') return null;
  return it[kind] || (meta ? meta[kind] : null);
}

// What the browser gets to know about a video. File paths stay on this computer.
// `p` is the saved watch position, if any; guests are not told the file name.
function itemView(tmdb, it, p, guest) {
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
    hasLogo: Boolean(artSource(tmdb, it, 'logo')),
    duration: it.duration, width: it.width, height: it.height,
    vcodec: it.vcodec, size: it.size, addedAt: it.addedAt, playback: it.playback,
    file: guest ? undefined : path.basename(it.path),
    hasPoster: Boolean(artSource(tmdb, it, 'poster')), hasBackdrop: Boolean(artSource(tmdb, it, 'backdrop')),
    audio: it.audio,
    subs: [
      ...it.embedded.map((s) => ({ key: `e${s.n}`, lang: s.lang, title: s.title })),
      ...it.sidecars.map((s, n) => ({ key: `s${n}`, lang: s.lang, title: null })),
    ],
    position: p ? p.position : 0,
    watched: Boolean(p && p.watched),
  };
}

// Show-level details, keyed like the web app groups episodes.
function showViews(tmdb, items) {
  const out = {};
  if (!tmdb) return out;
  for (const it of items) {
    if (it.type !== 'episode' || out[it.showKey]) continue;
    const m = tmdb.for(it);
    if (m) out[it.showKey] = { overview: m.overview, tagline: m.tagline, genres: m.genres, rating: m.rating, cast: m.cast, creators: m.creators };
  }
  return out;
}

module.exports = { artSource, itemView, showViews };
