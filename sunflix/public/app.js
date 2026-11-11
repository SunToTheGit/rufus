'use strict';
/* SunFlix web client. Plain DOM, hash routing, no build step. */

// Where the SunFlix server is. Empty when this page is served by the server itself; the
// hosted copy of the web app (see netlify.toml) points it at the owner's server.
const BASE = String(window.SUNFLIX_SERVER || '').replace(/\/+$/, '');
// A published copy (publish.js) has no server at all: the library is a file next to this
// page and the videos sit in a storage bucket at MEDIA.
const STATIC = Boolean(window.SUNFLIX_STATIC);
const MEDIA = String(window.SUNFLIX_MEDIA || '').replace(/\/+$/, '');

const app = document.getElementById('app');
const S = { items: [], byId: new Map(), shows: new Map(), cont: [], status: {}, mediaDirs: [], loaded: false };
let player = null;   // { destroy() } while a video is open
let pollTimer = null;

// ------------------------------------------------------------------ helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with the ICON constants below
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M5 5h6v2H7v4H5zM13 5h6v6h-2V7h-4zM5 13h2v4h4v2H5zM17 13h2v6h-6v-2h4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9zM16 8.200v7.600a4.500 4.500 0 0 0 0-7.600z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9zM21 9.400 19.600 8 17.500 10.100 15.400 8 14 9.400l2.100 2.100L14 13.600l1.400 1.400 2.100-2.100 2.100 2.100 1.400-1.400-2.100-2.100z"/></svg>',
  rew: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.800 12z"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M8.600 5.400 10 4l8 8-8 8-1.400-1.400L15.200 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5v14l9-7zM16 5h2.500v14H16z"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2.500 4.500v2h7v-2zm9 0v2h2v-2zm-9 3.500v2h3v-2zm5 0v2h6.500v-2z" fill-rule="evenodd"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
};

function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function runtime(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 1) return `${Math.round(sec || 0)}s`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

const quality = (it) => (it.height >= 2000 || it.width >= 3800 ? '4K' : it.height >= 1000 || it.width >= 1900 ? 'HD 1080' : it.height >= 700 ? 'HD 720' : 'SD');
const epCode = (it) => `S${it.season} E${it.episode}`;
function art(id, kind, w) {
  if (!STATIC) return `${BASE}/art/${id}?kind=${kind}&w=${w}`;
  const made = (S.byId.get(id) || {}).art || {};
  return made[kind === 'logo' ? 'logo' : kind + w] || made.backdrop640 || '';
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let langNames = null;
function langLabel(track, fallback) {
  let name = track.title || '';
  if (track.lang && track.lang !== 'und') {
    try {
      langNames = langNames || new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
      const pretty = langNames.of(track.lang);
      name = name ? `${pretty} (${name})` : pretty;
    } catch { name = name || track.lang; }
  }
  return name || fallback;
}

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Guests of a public library keep their place in this browser; the owner's is kept on the server.
const LOCAL_PROGRESS = 'sunflix-progress';
function localProgress() {
  try { return JSON.parse(localStorage.getItem(LOCAL_PROGRESS)) || {}; } catch { return {}; }
}
function saveLocal(id, entry) {
  try {
    const all = localProgress();
    all[id] = { ...entry, updatedAt: Date.now() };
    localStorage.setItem(LOCAL_PROGRESS, JSON.stringify(all));
  } catch { /* private mode: nothing is remembered */ }
}

function saveProgress(item, position) {
  if (!S.guest) return api(`/api/progress/${item.id}`, { position }).catch(() => {});
  const watched = item.duration > 0 && position >= item.duration * 0.92;
  saveLocal(item.id, { position: watched ? 0 : position, watched });
  return Promise.resolve();
}

function markWatched(item, watched) {
  if (!S.guest) return api(`/api/watched/${item.id}`, { watched });
  saveLocal(item.id, { position: 0, watched });
  return Promise.resolve();
}

// The guest version of the server's Continue watching list: videos in progress, plus the
// next episode of a show whose latest episode was finished.
function localContinue(local) {
  const stamp = new Map();
  for (const it of S.items) {
    const p = local[it.id];
    if (p && !p.watched && p.position > 15) stamp.set(it, p.updatedAt);
  }
  for (const show of S.shows.values()) {
    const seen = show.episodes.filter((e) => local[e.id]);
    if (!seen.length) continue;
    const last = seen.reduce((a, b) => (local[b.id].updatedAt > local[a.id].updatedAt ? b : a));
    const next = show.episodes[show.episodes.indexOf(last) + 1];
    if (local[last.id].watched && next && !(local[next.id] || {}).watched && !stamp.has(next)) stamp.set(next, local[last.id].updatedAt);
  }
  return [...stamp].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([it]) => it);
}

// ------------------------------------------------------------------ library

async function loadLibrary() {
  const lib = STATIC ? await fetch('library.json', { cache: 'no-cache' }).then((r) => r.json()) : await api('/api/library');
  S.items = lib.items;
  S.byId = new Map(lib.items.map((it) => [it.id, it]));
  S.cont = lib.continue.map((id) => S.byId.get(id)).filter(Boolean);
  S.status = lib.status;
  S.mediaDirs = lib.mediaDirs;
  S.shows = new Map();
  for (const it of lib.items) {
    if (it.type !== 'episode') continue;
    if (!S.shows.has(it.showKey)) S.shows.set(it.showKey, { key: it.showKey, name: it.show, year: it.year, episodes: [], addedAt: 0 });
    const show = S.shows.get(it.showKey);
    show.episodes.push(it);
    show.addedAt = Math.max(show.addedAt, it.addedAt);
    show.year = show.year || it.year;
  }
  for (const show of S.shows.values()) {
    show.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    Object.assign(show, lib.shows[show.key]); // synopsis, cast and so on, when TMDB lookup is on
  }
  S.meta = lib.metadata;
  S.guest = Boolean(lib.guest);
  if (S.guest) {
    const local = localProgress();
    for (const it of S.items) {
      const p = local[it.id];
      if (p) { it.position = p.position || 0; it.watched = Boolean(p.watched); }
    }
    S.cont = localContinue(local);
  }
  S.loaded = true;
  document.getElementById('logout').hidden = !lib.canLogout;
  document.getElementById('login').hidden = !(lib.canLogin && !BASE); // owner sign-in only works on the server's own address
  document.getElementById('rescan').hidden = S.guest;
  const btn = document.getElementById('rescan');
  const looking = Boolean(S.meta && S.meta.busy);
  btn.disabled = lib.status.scanning;
  btn.classList.toggle('busy', lib.status.scanning || looking);
  btn.title = lib.status.scanning ? `Scanning ${lib.status.done} of ${lib.status.total}`
    : looking ? `Fetching details for ${S.meta.done} of ${S.meta.total} titles` : 'Look for new files';
  clearTimeout(pollTimer);
  if (lib.status.scanning || looking) pollTimer = setTimeout(() => refresh().catch(() => {}), 1500);
}

async function refresh() {
  await loadLibrary();
  if (!player) render();
}

const movies = () => S.items.filter((it) => it.type === 'movie');
const byTitle = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

// -------------------------------------------------------------------- cards

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// An image that fades in once it has loaded and quietly disappears if it can't.
function picture(src, cls) {
  return h('img', {
    class: `fade ${cls || ''}`, alt: '', loading: 'lazy',
    onload: (e) => e.target.classList.add('in'), onerror: (e) => e.target.remove(), src,
  });
}

function progressBar(it) {
  const pct = it && it.duration && it.position ? Math.min(100, (it.position / it.duration) * 100) : 0;
  return pct ? h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null;
}

// Portrait card for a title. With no poster on disk, a frame is cropped and the title set on it.
function posterCard(href, title, sub, it, progress) {
  return h('a', { class: 'card poster', href, 'aria-label': title },
    h('div', { class: 'art' },
      picture(it.hasPoster ? art(it.id, 'poster', 400) : art(it.id, 'backdrop', 640)),
      it.hasPoster ? null : h('div', { class: 'typeset' }, h('b', {}, title), sub ? h('span', {}, sub) : null),
      progress));
}

const movieCard = (it) => posterCard(`#/item/${it.id}`, it.title, it.year ? String(it.year) : null, it, progressBar(it));
const showCard = (show) => posterCard(`#/show/${show.key}`, show.name, plural(show.episodes.length, 'episode'), show.episodes[0], null);

// Landscape card that starts playback straight away (Continue watching, episode search hits).
function playCard(it) {
  const isEp = it.type === 'episode';
  const left = it.position ? `${runtime(it.duration - it.position)} left` : runtime(it.duration);
  return h('a', { class: 'card', href: `#/play/${it.id}` },
    h('div', { class: 'art' },
      picture(art(it.id, isEp ? 'frame' : 'backdrop', 640)),
      h('div', { class: 'glyph', html: ICON.play }),
      progressBar(it)),
    h('div', { class: 't' }, isEp ? it.show : it.title),
    h('div', { class: 's' }, isEp ? `${epCode(it)} · ${it.title}` : left));
}

// A horizontally scrolling row with paddle buttons that only show when there is more to see.
function shelf(title, cards, opts = {}) {
  if (!cards.length) return null;
  const row = h('div', { class: `row${opts.wide ? ' wide' : ''}` }, cards);
  const page = (dir) => row.scrollBy({ left: dir * row.clientWidth * 0.85, behavior: reducedMotion ? 'auto' : 'smooth' });
  const prev = h('button', { class: 'paddle prev', type: 'button', tabindex: -1, 'aria-label': `Scroll ${title} back`, html: ICON.left, onclick: () => page(-1) });
  const next = h('button', { class: 'paddle next', type: 'button', tabindex: -1, 'aria-label': `Scroll ${title} forward`, html: ICON.right, onclick: () => page(1) });
  const sync = () => {
    prev.hidden = row.scrollLeft < 8;
    next.hidden = row.scrollLeft + row.clientWidth > row.scrollWidth - 8;
  };
  row.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(row);
  return h('section', { class: 'shelf' },
    h('h2', {}, opts.href ? h('a', { href: opts.href }, title, h('span', { class: 'more' }, 'See all')) : title),
    h('div', { class: `rail${opts.wide ? ' wide' : ''}` }, prev, row, next));
}

// -------------------------------------------------------------------- views

let heroTimer = null;

// Full-bleed artwork with the title over it. Several slides make a rotating spotlight.
function hero(slides, detail) {
  const layers = slides.map((s) => h('img', {
    class: 'bg', alt: '', onload: (e) => e.target.classList.add('in'), onerror: (e) => e.target.remove(), src: s.bg,
  }));
  const info = h('div', { class: 'info' });
  let current = 0;
  const pager = slides.length > 1 ? h('div', { class: 'pager' }, slides.map((s, i) =>
    h('button', { type: 'button', 'aria-label': `Show ${s.title}`, onclick: () => show(i) }))) : null;
  function show(i) {
    current = i;
    const s = slides[i];
    layers.forEach((layer, j) => layer.classList.toggle('on', j === i));
    if (pager) [...pager.children].forEach((dot, j) => dot.classList.toggle('on', j === i));
    info.replaceChildren(...[
      s.eyebrow ? h('div', { class: 'eyebrow' }, s.eyebrow) : null,
      // Title art when TMDB has it, plain text otherwise (and if the image fails to load).
      h('h1', {}, s.logo ? h('img', { src: s.logo, alt: s.title, onerror: (e) => e.target.replaceWith(s.title) }) : s.title),
      h('div', { class: 'meta' }, s.meta),
      s.overview ? h('p', { class: 'overview' }, s.overview) : null,
      h('div', { class: 'actions' }, s.actions),
    ].filter(Boolean));
    info.classList.remove('swap');
    void info.offsetWidth; // restart the entrance animation
    info.classList.add('swap');
  }
  const root = h('div', { class: `hero${detail ? ' detail' : ''}` }, layers, h('div', { class: 'scrim' }), info, pager);
  show(0);
  clearInterval(heroTimer);
  if (slides.length > 1 && !reducedMotion) {
    heroTimer = setInterval(() => {
      if (!root.isConnected) { clearInterval(heroTimer); return; }
      if (document.hidden || root.matches(':hover, :focus-within')) return; // don't move it under someone's cursor
      show((current + 1) % slides.length);
    }, 9000);
  }
  return root;
}

function playButton(it, label) {
  const text = label || (it.position > 15 ? `Resume · ${runtime(it.duration - it.position)} left` : 'Play');
  return h('a', { class: 'btn primary', href: `#/play/${it.id}`, html: ICON.play }, text);
}

// Rating and genres, for a movie or a show, when TMDB lookup is on.
function acclaim(x) {
  return [
    x.rating ? h('span', { class: 'rating', title: 'TMDB user score' }, `★ ${x.rating.toFixed(1)}`) : null,
    x.genres && x.genres.length ? h('span', {}, x.genres.slice(0, 2).join(' · ')) : null,
  ];
}

const logoOf = (it) => (it.hasLogo ? art(it.id, 'logo', 640) : null);

function itemMeta(it) {
  return [
    ...acclaim(it),
    it.year ? h('span', {}, String(it.year)) : null,
    h('span', {}, runtime(it.duration)),
    h('span', { class: 'tag' }, quality(it)),
    it.subs.length ? h('span', { class: 'tag' }, 'CC') : null,
    it.watched ? h('span', { class: 'check' }, '✓ Watched') : null,
  ];
}

// The episode to offer for a show: the first one not yet watched.
const upNextIn = (show) => show.episodes.find((e) => !e.watched) || show.episodes[0];

function slideFor(it, eyebrow) {
  if (it.type === 'episode') {
    const show = S.shows.get(it.showKey);
    return {
      bg: art(show.episodes[0].id, 'backdrop', 1920), eyebrow, title: show.name, logo: logoOf(show.episodes[0]),
      overview: it.overview || show.overview,
      meta: [...acclaim(show), h('span', {}, `${epCode(it)} · ${it.title}`), h('span', {}, runtime(it.duration)), h('span', { class: 'tag' }, quality(it))],
      actions: [playButton(it, it.position > 15 ? `Resume ${epCode(it)}` : `Play ${epCode(it)}`),
        h('a', { class: 'btn', href: `#/show/${show.key}` }, 'Episodes')],
    };
  }
  return {
    bg: art(it.id, 'backdrop', 1920), eyebrow, title: it.title, logo: logoOf(it), overview: it.overview, meta: itemMeta(it),
    actions: [playButton(it), h('a', { class: 'btn', href: `#/item/${it.id}` }, 'Details')],
  };
}

function emptyState() {
  const scanning = S.status.scanning;
  if (S.guest && !scanning) return h('div', { class: 'empty' }, h('h1', {}, 'Nothing to watch yet'), h('p', {}, 'This library is empty for now. Check back later.'));
  return h('div', { class: 'empty' },
    h('h1', {}, scanning ? 'Scanning your library…' : 'Nothing to watch yet'),
    scanning
      ? h('p', {}, `${S.status.done} of ${S.status.total} files checked.`)
      : [h('p', {}, 'Drop video files into a media folder and they will show up here. SunFlix is watching:'),
        S.mediaDirs.map((d) => h('code', {}, d)),
        h('p', {}, 'Name movies like “Title (2021).mkv” and episodes like “Show S01E02.mkv” so they sort themselves out.'),
        h('div', { class: 'actions', style: 'justify-content:center' },
          h('button', { class: 'btn primary', type: 'button', onclick: rescan }, 'Look again now'))]);
}

// A shelf for each of the biggest genres, once a genre has enough titles to be worth a row.
function genreShelves(allMovies, allShows) {
  const byGenre = new Map();
  const add = (x, card) => {
    for (const g of x.genres || []) {
      if (!byGenre.has(g)) byGenre.set(g, []);
      byGenre.get(g).push({ card, addedAt: x.addedAt });
    }
  };
  for (const m of allMovies) add(m, () => movieCard(m));
  for (const s of allShows) add(s, () => showCard(s));
  return [...byGenre].filter(([, list]) => list.length >= 4).sort((a, b) => b[1].length - a[1].length).slice(0, 4)
    .map(([genre, list]) => shelf(genre, list.sort((a, b) => b.addedAt - a.addedAt).slice(0, 24).map((x) => x.card())));
}

const titleKey = (it) => (it.type === 'episode' ? `s:${it.showKey}` : it.id);

function viewHome() {
  if (!S.items.length) return emptyState();
  const recent = [...S.items].sort((a, b) => b.addedAt - a.addedAt);
  const seen = new Set();
  const newest = []; // one entry per title, newest first
  for (const it of recent) {
    if (seen.has(titleKey(it))) continue;
    seen.add(titleKey(it));
    newest.push(it);
  }
  // Spotlight: what you were in the middle of, then the newest arrivals.
  const slides = [];
  const used = new Set();
  const add = (it, eyebrow) => {
    if (slides.length >= 5 || used.has(titleKey(it))) return;
    used.add(titleKey(it));
    slides.push(slideFor(it, eyebrow));
  };
  if (S.cont[0]) add(S.cont[0], 'Continue watching');
  for (const it of newest) add(it.type === 'episode' ? upNextIn(S.shows.get(it.showKey)) : it, it.type === 'episode' ? 'New episodes' : 'Just added');

  const allMovies = movies().sort((a, b) => byTitle(a.title, b.title));
  const allShows = [...S.shows.values()].sort((a, b) => byTitle(a.name, b.name));
  return [
    hero(slides),
    shelf('Continue watching', S.cont.map(playCard), { wide: true }),
    shelf('Recently added', newest.slice(0, 18).map((it) => (it.type === 'episode' ? showCard(S.shows.get(it.showKey)) : movieCard(it)))),
    genreShelves(allMovies, allShows),
    shelf('Movies', allMovies.slice(0, 30).map(movieCard), { href: '#/movies' }),
    shelf('Shows', allShows.slice(0, 30).map(showCard), { href: '#/shows' }),
  ];
}

function viewGrid(title, cards) {
  if (!S.items.length) return emptyState();
  return [h('h1', { class: 'page-title' }, title),
    cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'empty' }, h('p', {}, `No ${title.toLowerCase()} found.`))];
}

function facts(it) {
  const tracks = (list) => list.map((t, i) => langLabel(t, `Track ${i + 1}`)).join(', ');
  const codec = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2' }[it.vcodec] || (it.vcodec || '').toUpperCase();
  const named = it.audio.length > 1 || it.audio.some((a) => a.title || (a.lang && a.lang !== 'und'));
  const list = (xs) => (xs && xs.length ? xs.join(', ') : null);
  const rows = [
    list(it.directors) ? [it.directors.length > 1 ? 'Directors' : 'Director', list(it.directors)] : null,
    list(it.cast) ? ['Cast', list(it.cast)] : null,
    list(it.genres) ? ['Genres', list(it.genres)] : null,
    ['Video', `${it.width}×${it.height} · ${codec}${it.playback === 'direct' ? '' : it.playback === 'remux' ? ' · repackaged as you watch' : ' · converted as you watch'}`],
    named ? ['Audio', tracks(it.audio)] : null,
    it.subs.length ? ['Subtitles', tracks(it.subs)] : null,
    it.file ? ['File', it.file] : null,
  ];
  return h('dl', { class: 'facts' }, rows.filter(Boolean).map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
}

function showFacts(show) {
  const rows = [
    show.creators && show.creators.length ? ['Created by', show.creators.join(', ')] : null,
    show.cast && show.cast.length ? ['Cast', show.cast.join(', ')] : null,
    show.genres && show.genres.length ? ['Genres', show.genres.join(', ')] : null,
  ].filter(Boolean);
  return rows.length ? h('dl', { class: 'facts' }, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))) : null;
}

function viewItem(id) {
  const it = S.byId.get(id);
  if (!it) return viewMissing();
  const isEp = it.type === 'episode';
  const setWatched = async (watched) => { await markWatched(it, watched); await refresh(); };
  const others = movies().filter((m) => m.id !== it.id).sort((a, b) => Number(a.watched) - Number(b.watched) || b.addedAt - a.addedAt);
  return [
    hero([{
      bg: art(isEp ? S.shows.get(it.showKey).episodes[0].id : it.id, 'backdrop', 1920),
      eyebrow: isEp ? `${it.show} · ${epCode(it)}` : it.tagline || null,
      title: it.title,
      logo: isEp ? null : logoOf(it),
      overview: it.overview,
      meta: itemMeta(it),
      actions: [
        playButton(it),
        it.position > 15 ? h('a', { class: 'btn', href: `#/play/${it.id}?t=0` }, 'Start over') : null,
        h('button', { class: 'btn', type: 'button', onclick: () => setWatched(!it.watched) }, it.watched ? 'Mark unwatched' : 'Mark watched'),
        isEp ? h('a', { class: 'btn', href: `#/show/${it.showKey}?s=${it.season}` }, 'All episodes') : null,
      ],
    }], true),
    facts(it),
    isEp ? null : shelf('More movies', others.slice(0, 24).map(movieCard), { href: '#/movies' }),
  ];
}

function viewShow(key, query) {
  const show = S.shows.get(key);
  if (!show) return viewMissing();
  const seasons = [...new Set(show.episodes.map((e) => e.season))];
  const up = upNextIn(show);
  let current = Number(query.get('s'));
  if (!query.has('s') || !seasons.includes(current)) current = up.season;
  const seasonName = (n) => (n === 0 ? 'Specials' : `Season ${n}`);
  const others = [...S.shows.values()].filter((s) => s.key !== key).sort((a, b) => b.addedAt - a.addedAt);
  return [
    hero([{
      bg: art(show.episodes[0].id, 'backdrop', 1920),
      title: show.name,
      logo: logoOf(show.episodes[0]),
      overview: show.overview,
      meta: [...acclaim(show), show.year ? h('span', {}, String(show.year)) : null,
        h('span', {}, plural(seasons.length, 'season')), h('span', {}, plural(show.episodes.length, 'episode'))],
      actions: [playButton(up, up.position > 15 ? `Resume ${epCode(up)}` : `Play ${epCode(up)}`)],
    }], true),
    seasons.length > 1 ? h('div', { class: 'seasons' }, seasons.map((n) =>
      h('button', { type: 'button', class: n === current ? 'on' : '', onclick: () => { location.replace(`#/show/${key}?s=${n}`); } }, seasonName(n)))) : null,
    h('div', { class: 'episodes' }, show.episodes.filter((e) => e.season === current).map((e) =>
      h('a', { class: 'ep', href: `#/play/${e.id}` },
        h('div', { class: 'n' }, String(e.episode)),
        h('div', { class: 'art' }, picture(art(e.id, 'frame', 640)), h('div', { class: 'glyph', html: ICON.play }), progressBar(e)),
        h('div', {},
          h('h3', {}, e.title, e.watched ? h('span', { class: 'check' }, ' ✓') : null),
          h('p', {}, e.position > 15 ? `${runtime(e.duration - e.position)} left` : runtime(e.duration)),
          e.overview ? h('p', { class: 'synopsis' }, e.overview) : null)))),
    showFacts(show),
    shelf('More shows', others.slice(0, 24).map(showCard), { href: '#/shows' }),
  ];
}

function viewSearch(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return viewHome();
  const hit = (s) => (s || '').toLowerCase().includes(needle);
  const about = (x) => [...(x.genres || []), ...(x.cast || []), ...(x.directors || []), ...(x.creators || [])].some(hit);
  const titles = [...[...S.shows.values()].filter((show) => hit(show.name) || about(show)).map(showCard),
    ...movies().filter((it) => hit(it.title) || about(it)).map(movieCard)];
  const eps = S.items.filter((it) => it.type === 'episode' && hit(it.title)).slice(0, 40).map(playCard);
  return [h('h1', { class: 'page-title' }, `Results for “${q.trim()}”`),
    titles.length ? h('div', { class: 'grid' }, titles) : null,
    eps.length ? [h('h2', { class: 'subhead' }, 'Episodes'), h('div', { class: 'grid wide' }, eps)] : null,
    titles.length || eps.length ? null : h('div', { class: 'empty' }, h('p', {}, 'Nothing in your library matches that.'))];
}

function viewMissing() {
  return h('div', { class: 'empty' }, h('h1', {}, 'Not found'),
    h('p', {}, 'That video is no longer in the library.'),
    h('div', { class: 'actions', style: 'justify-content:center' }, h('a', { class: 'btn primary', href: '#/' }, 'Back home')));
}

function showLogin() {
  if (player) { player.destroy(); player = null; }
  document.body.classList.add('locked');
  const input = h('input', { type: 'password', placeholder: 'Password', 'aria-label': 'Password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('/api/login', { password: input.value });
      document.body.classList.remove('locked');
      await refresh();
    } catch (ex) { err.textContent = ex.message; input.select(); }
  } },
  h('div', { class: 'logo' }, h('span', {}, h('b', {}, 'Sun'), 'Flix')),
  input, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), err,
  // In a public library signing in is optional, so there has to be a way back out.
  S.guest ? h('button', { class: 'ghost', type: 'button', onclick: () => { document.body.classList.remove('locked'); render(); } }, 'Back to the library') : null);
  app.replaceChildren(form);
  input.focus();
}

// ------------------------------------------------------------------- player

function parseVtt(text) {
  const stamp = (s) => s.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    const m = i >= 0 && /([\d:.]+)\s*-->\s*([\d:.]+)/.exec(lines[i]);
    if (!m) continue;
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>|\{\\[^}]*\}/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
    if (body) cues.push({ start: stamp(m[1]), end: stamp(m[2]), text: body });
  }
  return cues;
}

function openPlayer(id, query) {
  const item = S.byId.get(id);
  if (!item) { app.replaceChildren(viewMissing()); return null; }
  const dur = item.duration || 0;
  const isEp = item.type === 'episode';
  const eps = isEp ? S.shows.get(item.showKey).episodes : [];
  const next = isEp ? eps[eps.indexOf(item) + 1] : null;

  // Files the browser can't play natively come from /transcode, which is a
  // live stream that always starts at zero. `offset` maps it back to real time.
  const P = { mode: item.playback === 'direct' ? 'direct' : 'transcode', offset: 0, target: 0, audio: 0, sub: '', cues: [], scrubbing: false, done: false, declinedNext: false };

  const div = (cls, ...kids) => h('div', { class: cls }, ...kids);
  const button = (label, icon, onclick, cls) => h('button', { class: `icon ${cls || ''}`, type: 'button', 'aria-label': label, title: label, html: icon, onclick });

  const video = h('video', { playsinline: true, preload: 'auto', poster: art(item.id, 'backdrop', 1920) });
  const cueBox = div('cues');
  const spin = div('spin');
  const msg = h('div', { class: 'pmsg', hidden: true });
  const bezel = h('div', { class: 'bezel', 'aria-live': 'polite' });
  const playBtn = button('Play', ICON.play, toggle, 'big');
  const muteBtn = button('Mute', ICON.vol, () => { video.muted = !video.muted; });
  const vol = h('input', { class: 'vol', type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  const elapsed = h('span', { class: 'time' }, '0:00');
  const remaining = h('span', { class: 'time' }, `-${clock(dur)}`);

  // Timeline: played and buffered fills, a knob, and a tip with a preview frame.
  const played = div('played');
  const buffered = div('buffered');
  const knob = div('knob');
  const tipTime = h('span', {});
  const tipImg = h('img', { alt: '', onload: (e) => e.target.classList.add('in'), onerror: (e) => e.target.classList.remove('in') });
  const tip = h('div', { class: 'tip', hidden: true }, tipImg, tipTime);
  const scrub = h('div', { class: 'scrub', role: 'slider', tabindex: 0, 'aria-label': 'Seek', 'aria-valuemin': 0, 'aria-valuemax': Math.floor(dur) },
    div('track', buffered, played), knob, tip);

  // Paused: say what this is and how much is left.
  const infoLeft = h('p', {});
  const info = div('pinfo',
    h('div', { class: 'eyebrow' }, isEp ? `${item.show} · ${epCode(item)}` : (item.year ? String(item.year) : '')),
    h('h2', {}, item.title), infoLeft, item.overview ? h('p', { class: 'synopsis' }, item.overview) : null);

  const menu = h('div', { class: 'pmenu', role: 'menu', hidden: true });
  const menuBtn = item.subs.length || item.audio.length > 1 ? button('Audio and subtitles', ICON.cc, () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) { drawMenu(); (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus(); }
  }) : null;

  const upCount = h('span', {});
  const upCard = next ? h('div', { class: 'upcard', hidden: true },
    div('art', picture(art(next.id, 'frame', 640))),
    div('uptext', h('small', {}, 'Up next'), h('b', {}, `${epCode(next)} · ${next.title}`), upCount),
    div('upactions',
      h('button', { class: 'btn primary', type: 'button', onclick: goNext }, 'Play now'),
      h('button', { class: 'btn', type: 'button', onclick: () => { P.declinedNext = true; upCard.hidden = true; } }, 'Not now'))) : null;

  const exit = () => { location.hash = isEp ? `#/show/${item.showKey}?s=${item.season}` : `#/item/${item.id}`; };

  const root = h('div', { class: 'player' },
    video, div('pshade'), spin, msg, cueBox, bezel,
    div('ptop',
      button('Back', ICON.back, exit),
      h('div', { class: 'ptitle' }, isEp ? item.show : item.title,
        h('small', {}, isEp ? `${epCode(item)} · ${item.title}` : [item.year, quality(item)].filter(Boolean).join(' · '))),
      next ? button(`Next episode: ${epCode(next)}`, ICON.next, goNext) : null,
      menuBtn ? div('menuwrap', menuBtn, menu) : null,
      muteBtn, vol,
      button('Fullscreen', ICON.full, fullscreen)),
    div('pcenter',
      button('Back 10 seconds', ICON.rew, () => skip(-10), 'mid'),
      playBtn,
      button('Forward 10 seconds', ICON.fwd, () => skip(10), 'mid')),
    div('pbot', info, scrub, div('ptimes', elapsed, remaining)),
    upCard);

  const now = () => (P.mode === 'direct' ? video.currentTime : P.offset + video.currentTime);
  const clamp = (t) => Math.max(0, Math.min(t, Math.max(0, dur - 2)));

  let loads = 0;
  async function load(t) {
    t = clamp(t);
    const mine = ++loads;
    P.loading = true;
    P.target = t;
    spin.hidden = false;
    msg.hidden = true;
    if (P.mode === 'direct') {
      P.offset = 0;
      video.src = STATIC ? `${MEDIA}/${item.video}` : `${BASE}/stream/${item.id}`;
      if (t > 0) video.addEventListener('loadedmetadata', () => { if (mine === loads) video.currentTime = t; }, { once: true });
    } else {
      video.pause();
      // Copied video can only start on a keyframe, so ask where this stream will really begin.
      const real = t > 0 ? await api(`/api/start/${item.id}?t=${t.toFixed(3)}`).then((r) => r.start, () => t) : 0;
      if (mine !== loads || P.done) return; // a newer seek, or the player closed, while we waited
      P.offset = real;
      video.src = `${BASE}/transcode/${item.id}?t=${real.toFixed(3)}&a=${P.audio}`;
    }
    // Autoplay refused by the browser: leave the controls up with the play button waiting.
    video.play().catch(() => { if (mine === loads) { spin.hidden = true; P.loading = false; root.classList.add('paused'); } });
  }

  function seek(t) {
    t = clamp(t);
    if (P.mode === 'direct') video.currentTime = t;
    else load(t);
    paint(t);
  }

  function skip(by) {
    seek(now() + by);
    flash(by < 0 ? `−${-by}s` : `+${by}s`);
  }

  function paint(t) {
    const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
    elapsed.textContent = clock(t);
    remaining.textContent = `-${clock(dur - t)}`;
    played.style.width = `${pct}%`;
    knob.style.left = `${pct}%`;
    scrub.setAttribute('aria-valuenow', Math.floor(t));
    scrub.setAttribute('aria-valuetext', `${clock(t)} of ${clock(dur)}`);
  }

  function paintBuffered() {
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
    }
    const real = P.mode === 'direct' ? end : P.offset + end;
    buffered.style.width = `${dur ? Math.min(100, (real / dur) * 100) : 0}%`;
  }

  // A short confirmation in the middle of the screen, so a key press is never a guess.
  function flash(text) {
    bezel.textContent = text;
    bezel.classList.remove('show');
    void bezel.offsetWidth;
    bezel.classList.add('show');
  }

  function toggle() {
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  }

  function setVolume(v) {
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, v));
    flash(`Volume ${Math.round(video.volume * 100)}%`);
  }

  function report(position) {
    if (P.done) return Promise.resolve();
    const t = position == null ? now() : position;
    if (!(t > 0)) return Promise.resolve();
    return saveProgress(item, t);
  }

  async function goNext() {
    await report(dur); // counts this one as watched
    P.done = true;
    location.hash = `#/play/${next.id}?t=0`;
  }

  // ---- audio and subtitles

  async function setSub(key, remember) {
    P.sub = key;
    P.cues = [];
    cueBox.replaceChildren();
    const track = item.subs.find((s) => s.key === key);
    if (remember) { try { localStorage.setItem('sunflix-subs', track ? track.lang || 'on' : ''); } catch { /* private mode */ } }
    if (menuBtn) menuBtn.classList.toggle('active', Boolean(key));
    drawMenu();
    if (!key) return;
    try {
      const res = await fetch(STATIC ? `subs/${item.id}-${key}.vtt` : `${BASE}/subs/${item.id}/${key}`);
      if (!res.ok) throw new Error();
      const cues = parseVtt(await res.text());
      if (P.sub === key) P.cues = cues;
    } catch {
      if (P.sub === key) { setSub('', false); flash('Subtitles unavailable'); }
    }
  }

  function setAudio(i) {
    const t = now();
    P.audio = i;
    P.mode = i === 0 && item.playback === 'direct' ? 'direct' : 'transcode'; // only the server can switch tracks
    drawMenu();
    load(t);
  }

  function drawMenu() {
    const row = (label, checked, onclick) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), onclick },
      h('span', { class: 'tick' }, checked ? '✓' : ''), label);
    menu.replaceChildren(...[
      item.subs.length ? h('div', {}, h('h4', {}, 'Subtitles'),
        row('Off', !P.sub, () => setSub('', true)),
        item.subs.map((s, i) => row(langLabel(s, `Track ${i + 1}`), P.sub === s.key, () => setSub(s.key, true)))) : null,
      item.audio.length > 1 ? h('div', {}, h('h4', {}, 'Audio'),
        item.audio.map((a, i) => row(langLabel(a, `Audio ${i + 1}`), P.audio === i, () => setAudio(i)))) : null,
    ].filter(Boolean));
  }

  // ---- timeline

  const step = item.previewStep || Math.max(10, Math.ceil(dur / 240)); // preview frames are shared per time bucket
  let previewTimer = null;
  const timeAt = (e) => {
    const r = scrub.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  };
  function showTip(e) {
    const r = scrub.getBoundingClientRect();
    const t = timeAt(e);
    tip.hidden = false;
    tip.style.left = `${Math.max(104, Math.min(r.width - 104, e.clientX - r.left))}px`;
    tipTime.textContent = clock(t);
    const bucket = String(Math.floor(t / step) * step);
    if (tipImg.dataset.bucket === bucket) return;
    tipImg.dataset.bucket = bucket;
    clearTimeout(previewTimer); // only fetch the frame the pointer settles on
    previewTimer = setTimeout(() => { tipImg.classList.remove('in'); tipImg.src = STATIC ? `${MEDIA}/previews/${item.id}/${Number(bucket) / step + 1}.jpg` : `${BASE}/preview/${item.id}?t=${bucket}`; }, 90);
  }
  scrub.addEventListener('pointermove', (e) => { if (!dur) return; showTip(e); if (P.scrubbing) paint(timeAt(e)); });
  scrub.addEventListener('pointerleave', () => { if (!P.scrubbing) tip.hidden = true; });
  scrub.addEventListener('pointerdown', (e) => {
    if (!dur) return;
    scrub.setPointerCapture(e.pointerId);
    P.scrubbing = true;
    root.classList.add('scrubbing');
    showTip(e);
    paint(timeAt(e));
  });
  const endScrub = (e, commit) => {
    if (!P.scrubbing) return;
    P.scrubbing = false;
    root.classList.remove('scrubbing');
    if (commit) seek(timeAt(e));
    if (e.pointerType !== 'mouse') tip.hidden = true;
  };
  scrub.addEventListener('pointerup', (e) => endScrub(e, true));
  scrub.addEventListener('pointercancel', (e) => endScrub(e, false));

  // ---- showing and hiding the controls

  let idleTimer = null;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !P.scrubbing && menu.hidden) root.classList.add('idle'); else wake();
    }, 3000);
  }

  video.addEventListener('timeupdate', () => {
    const t = now();
    if (t >= P.target) P.target = 0;
    if (!P.scrubbing) paint(t);
    paintBuffered();
    const cue = P.cues.find((c) => t >= c.start && t <= c.end);
    cueBox.replaceChildren(cue ? h('span', {}, cue.text) : '');
    if (upCard && !P.declinedNext) {
      const left = dur - t;
      upCard.hidden = !(dur && left < 25);
      upCount.textContent = `Starts in ${Math.max(1, Math.ceil(left))}s`;
    }
  });
  video.addEventListener('progress', paintBuffered);
  video.addEventListener('playing', () => {
    spin.hidden = true;
    P.loading = false;
    root.classList.remove('paused');
    playBtn.innerHTML = ICON.pause;
    playBtn.setAttribute('aria-label', 'Pause');
    playBtn.title = 'Pause';
    wake();
  });
  video.addEventListener('waiting', () => { spin.hidden = false; });
  video.addEventListener('pause', () => {
    playBtn.innerHTML = ICON.play;
    playBtn.setAttribute('aria-label', 'Play');
    playBtn.title = 'Play';
    if (!P.loading) { // a real pause, not the gap while a new stream loads
      infoLeft.textContent = `${runtime(dur - now())} left`;
      root.classList.add('paused');
    }
    root.classList.remove('idle');
    report();
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    const t = Math.max(now(), P.target);
    if (P.mode === 'direct' && !STATIC) { P.mode = 'transcode'; load(t); return; } // let the server convert it instead
    spin.hidden = true;
    msg.hidden = false;
    msg.textContent = STATIC ? 'This video could not be played. It may still be uploading, or your browser may not support it.'
      : 'This video could not be played right now. The server may be busy converting other videos, or the file may be damaged.';
  });
  video.addEventListener('ended', async () => {
    const finished = !dur || now() > dur * 0.92;
    if (!finished) return; // stream cut short; leave the viewer where they were
    if (next && !P.declinedNext) { goNext(); return; }
    await report(dur);
    P.done = true;
    exit();
  });

  // Mouse: click the picture to play or pause. Touch: a tap shows or hides the controls.
  let touch = false;
  let tapWasIdle = false;
  root.addEventListener('pointerdown', (e) => {
    touch = e.pointerType === 'touch';
    tapWasIdle = root.classList.contains('idle');
    if (!menu.hidden && !e.target.closest('.menuwrap')) menu.hidden = true;
    wake();
  });
  root.addEventListener('pointermove', wake);
  video.addEventListener('click', () => {
    if (!touch) toggle();
    else if (!tapWasIdle && !video.paused) root.classList.add('idle');
  });
  video.addEventListener('dblclick', () => { if (!touch) fullscreen(); });
  vol.addEventListener('input', () => { video.volume = Number(vol.value); video.muted = false; });
  video.addEventListener('volumechange', () => {
    const silent = video.muted || !video.volume;
    muteBtn.innerHTML = silent ? ICON.mute : ICON.vol;
    muteBtn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    vol.value = video.muted ? 0 : video.volume;
    try { localStorage.setItem('sunflix-volume', String(video.volume)); } catch { /* private mode */ }
  });

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!menu.hidden) {
      // The menu is a small list: arrows walk it, Escape closes it.
      const rows = [...menu.querySelectorAll('button')];
      const at = rows.indexOf(document.activeElement);
      if (k === 'escape') { menu.hidden = true; menuBtn.focus(); } else if (k === 'arrowdown' || k === 'arrowup') {
        rows[(at + (k === 'arrowdown' ? 1 : rows.length - 1)) % rows.length].focus();
      } else return;
      e.preventDefault();
      return;
    }
    const onButton = e.target.closest('button');
    if (k === ' ' || k === 'k' || (k === 'enter' && !onButton)) { if (onButton && k === ' ') return; toggle(); } else if (k === 'arrowleft') skip(-10);
    else if (k === 'arrowright') skip(10);
    else if (k === 'arrowup') setVolume(video.volume + 0.05);
    else if (k === 'arrowdown') setVolume(video.volume - 0.05);
    else if (k === 'f') fullscreen();
    else if (k === 'm') { video.muted = !video.muted; flash(video.muted ? 'Muted' : 'Sound on'); } else if (k === 'c' && item.subs.length) {
      const pick = P.sub ? '' : item.subs[0].key;
      setSub(pick, true);
      flash(pick ? `Subtitles: ${langLabel(item.subs[0], 'on')}` : 'Subtitles off');
    } else if (/^[0-9]$/.test(k) && dur) { seek((dur * Number(k)) / 10); flash(k === '0' ? 'Start' : `${k}0%`); } else if (k === 'escape' && !document.fullscreenElement) exit();
    else return;
    e.preventDefault();
    wake();
  }
  const onLeave = () => {
    if (P.done || !(now() > 0)) return;
    if (S.guest) saveProgress(item, now());
    else navigator.sendBeacon(`${BASE}/api/progress/${item.id}`, new Blob([JSON.stringify({ position: now() })], { type: 'application/json' }));
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', onLeave);
  const ticker = setInterval(() => { if (!video.paused) report(); }, 10000);

  try {
    const saved = Number(localStorage.getItem('sunflix-volume'));
    if (saved > 0 && saved <= 1) { video.volume = saved; vol.value = saved; }
    // Bring back subtitles in the language chosen last time, if this video has it.
    const lang = localStorage.getItem('sunflix-subs');
    // "en" on a file next to the video and "eng" inside one are the same language.
    const name = (code) => langLabel({ lang: code }, code);
    const match = lang && (item.subs.find((s) => s.lang === lang || (s.lang && name(s.lang) === name(lang))) || (lang === 'on' ? item.subs[0] : null));
    if (match) setSub(match.key, false);
  } catch { /* private mode */ }

  document.body.classList.add('playing');
  app.replaceChildren(root);
  const resume = query.has('t') ? Number(query.get('t')) || 0 : (item.position > 15 && item.position < dur - 15 ? item.position : 0);
  paint(resume);
  load(resume);
  wake();

  return {
    async destroy() {
      clearInterval(ticker);
      clearTimeout(idleTimer);
      clearTimeout(previewTimer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onLeave);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      const last = report();
      P.done = true;
      video.pause();
      video.removeAttribute('src'); // also tells the server to stop transcoding
      video.load();
      document.body.classList.remove('playing');
      await last;
    },
  };
}

// ------------------------------------------------------------------- router

let renders = 0;
async function render() {
  if (document.body.classList.contains('locked')) return;
  const mine = ++renders;
  if (player) {
    const closing = player;
    player = null;
    await closing.destroy();
    await loadLibrary().catch(() => {}); // pick up the new watch position
    if (mine !== renders) return; // the visitor already moved on to another page
  }
  const [route, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, arg] = route.split('/').map(decodeURIComponent);
  const query = new URLSearchParams(qs || '');

  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = a.dataset.nav === (page || 'home') || (a.dataset.nav === 'shows' && page === 'show');
    a.classList.toggle('on', on);
  }
  const search = document.getElementById('search');
  if (page !== 'search' && document.activeElement !== search) search.value = '';

  if (page === 'play') { player = openPlayer(arg, query); return; }

  let view;
  if (page === 'movies') view = viewGrid('Movies', movies().sort((a, b) => byTitle(a.title, b.title)).map(movieCard));
  else if (page === 'shows') view = viewGrid('Shows', [...S.shows.values()].sort((a, b) => byTitle(a.name, b.name)).map(showCard));
  else if (page === 'show') view = viewShow(arg, query);
  else if (page === 'item') view = viewItem(arg);
  else if (page === 'search') view = viewSearch(query.get('q') || '');
  else view = viewHome();

  const samePage = render.last === route;
  render.last = route;
  const swap = () => {
    const keep = window.scrollY;
    app.replaceChildren(...[view].flat(Infinity).filter(Boolean),
      ...(S.meta ? [h('footer', { class: 'credit' }, 'Film and series details from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.')] : []));
    document.body.classList.toggle('has-hero', Boolean(app.querySelector(':scope > .hero')));
    window.scrollTo(0, samePage ? keep : 0);
    onScroll();
  };
  // Cross-fade between pages; a refresh of the same page or a search keystroke swaps instantly.
  if (document.startViewTransition && !samePage && page !== 'search' && !reducedMotion) {
    // A second navigation cuts the first cross-fade short, which the browser reports as a
    // rejection. The page is swapped either way, so there is nothing to handle.
    const fade = document.startViewTransition(swap);
    fade.ready.catch(() => {});
    fade.finished.catch(() => {});
  } else swap();
}

const topBar = document.getElementById('top');
function onScroll() { topBar.classList.toggle('solid', window.scrollY > 24); }
window.addEventListener('scroll', onScroll, { passive: true });

// Arrow keys move focus to the nearest card in that direction, so the library can be
// browsed from a couch with a remote or keyboard.
function moveFocus(dir) {
  const els = [...app.querySelectorAll('a.card, a.ep, .hero .btn, .seasons button')];
  const from = els.includes(document.activeElement) ? document.activeElement : null;
  if (!from) { if (els[0]) els[0].focus(); return; }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'left' || dir === 'up' ? -1 : 1;
  let best = null;
  let bestScore = Infinity;
  for (const el of els) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const sameRow = Math.abs(dy) < Math.max(a.height, b.height) / 2;
    if (horizontal ? !sameRow || dx * sign <= 4 : sameRow || dy * sign <= 4) continue;
    const score = horizontal ? Math.abs(dx) : Math.abs(dy) * 4 + Math.abs(dx);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: horizontal ? 'nearest' : 'center', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
}

document.addEventListener('keydown', (e) => {
  if (player || !e.key.startsWith('Arrow') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, select, textarea') || document.body.classList.contains('locked')) return;
  e.preventDefault();
  moveFocus(e.key.slice(5).toLowerCase());
});

window.addEventListener('hashchange', render);

document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value;
  const target = q.trim() ? `#/search?q=${encodeURIComponent(q)}` : '#/';
  if (location.hash.startsWith('#/search')) location.replace(target); else location.hash = target;
});

async function rescan() {
  await api('/api/scan', {}).catch(() => {});
  refresh().catch(() => {});
}
document.getElementById('rescan').addEventListener('click', rescan);

document.getElementById('login').addEventListener('click', showLogin);

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  refresh().catch(() => {}); // a private library answers with the sign-in page, a public one with the guest view
});

refresh().catch((err) => {
  if (!document.body.classList.contains('locked')) {
    app.replaceChildren(h('div', { class: 'empty' },
      h('h1', {}, BASE ? 'This library is offline right now' : 'Cannot reach SunFlix'),
      h('p', {}, BASE ? 'The computer that holds the videos is not answering. Try again in a little while.' : err.message)));
  }
});
