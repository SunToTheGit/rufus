'use strict';
// Turns a file path into movie / episode metadata using naming conventions
// shared with Plex and Jellyfin ("Title (Year)", "Show S01E02", "Season 1/").
const path = require('node:path');

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ts', '.m2ts',
  '.wmv', '.flv', '.mpg', '.mpeg', '.ogv',
]);

const TAGS = new RegExp(
  '\\b(2160p|1080[pi]|720p|576p|480p|4k|uhd|hdr(10)?|bluray|blu-ray|b[dr]rip|web[ -]?(dl|rip)|' +
  'hdtv|dvdrip|remux|x26[45]|h[ .]?26[45]|hevc|avc|xvid|divx|aac|ac3|dts|ddp?[ .]?5[ .]1|atmos|' +
  'proper|repack|extended|unrated|remastered|imax|multi|10bit)\\b', 'i');

function clean(s) {
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/_+/g, ' ');
  // Scene-style names use dots for spaces; names with real spaces keep theirs ("Mr. Robot").
  if (!/\s/.test(s.trim())) s = s.replace(/\.+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const trimEdges = (s) => s.replace(/^[\s\-–:]+|[\s\-–:([]+$/g, '').trim();

function cutTags(s) {
  const i = s.search(TAGS);
  return i > 0 ? s.slice(0, i) : s;
}

// Splits "Blade Runner 2049 (2017)" into title + year, using the last year found.
function splitYear(s) {
  const re = /[\s(]((?:19|20)\d{2})(?=[\s)]|$)/g;
  let m;
  let last = null;
  while ((m = re.exec(s))) last = m;
  if (!last || last.index === 0) return { title: trimEdges(s), year: null };
  return { title: trimEdges(s.slice(0, last.index)), year: Number(last[1]) };
}

function parseSeasonDir(name) {
  const c = clean(name);
  const m = c.match(/^(?:season|series|staffel|s)\s*(\d{1,3})$/i);
  if (m) return Number(m[1]);
  return /^specials?$/i.test(c) ? 0 : null;
}

function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function parseMedia(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const parent = path.basename(dir);
  const seasonDir = parseSeasonDir(parent);
  const name = clean(base);

  let prefix;
  let season;
  let episode;
  let rest;
  let m = name.match(/^(.*?)[\s\-]*\bs(\d{1,2})[\s\-]*e(\d{1,3})(?:[\s\-]*e\d{1,3})*\b(.*)$/i) ||
          name.match(/^(.*?)[\s\-]*\b(\d{1,2})x(\d{2,3})\b(.*)$/i);
  if (m) {
    [, prefix, season, episode, rest] = m;
  } else if (seasonDir !== null) {
    // "Show/Season 2/03 - Title.mkv"
    m = name.match(/^(?:episode|ep|e)?\s*(\d{1,3})\b(.*)$/i);
    if (m) { prefix = ''; season = seasonDir; episode = m[1]; rest = m[2]; }
  }

  if (m) {
    const showDir = seasonDir !== null ? path.dirname(dir) : dir;
    const showRaw = trimEdges(prefix) || clean(path.basename(showDir));
    const show = splitYear(trimEdges(cutTags(showRaw)));
    return {
      type: 'episode',
      show: show.title || 'Unknown show',
      showKey: slug(show.title || 'unknown'),
      year: show.year,
      season: Number(season),
      episode: Number(episode),
      title: trimEdges(cutTags(rest)) || `Episode ${Number(episode)}`,
      showDir,
    };
  }

  const movie = splitYear(trimEdges(cutTags(name)));
  if (!movie.year) movie.year = splitYear(clean(parent)).year;
  return { type: 'movie', title: movie.title || base, year: movie.year };
}

module.exports = { VIDEO_EXT, parseMedia, clean, slug };
