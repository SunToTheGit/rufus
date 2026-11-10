'use strict';
/* SunFlix web client. Plain DOM, hash routing, no build step. */

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
const art = (id, kind) => `/art/${id}${kind ? `?kind=${kind}` : ''}`;
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
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ------------------------------------------------------------------ library

async function loadLibrary() {
  const lib = await api('/api/library');
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
  for (const show of S.shows.values()) show.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  S.loaded = true;
  document.getElementById('logout').hidden = !lib.canLogout;
  const btn = document.getElementById('rescan');
  btn.disabled = lib.status.scanning;
  btn.textContent = lib.status.scanning ? `Scanning ${lib.status.done}/${lib.status.total}` : 'Rescan';
  clearTimeout(pollTimer);
  if (lib.status.scanning) pollTimer = setTimeout(() => refresh().catch(() => {}), 1500);
}

async function refresh() {
  await loadLibrary();
  if (!player) render();
}

const movies = () => S.items.filter((it) => it.type === 'movie');
const byTitle = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

// -------------------------------------------------------------------- cards

function thumb(src, label, it, badge) {
  const pct = it && it.duration && it.position ? Math.min(100, (it.position / it.duration) * 100) : 0;
  return h('div', { class: 'thumb' },
    h('div', { class: 'ph' }, (label || '?').trim().charAt(0).toUpperCase()),
    h('img', { src, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }),
    badge,
    pct ? h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null);
}

function movieCard(it) {
  const sub = [it.year, runtime(it.duration), it.watched ? 'Watched' : null].filter(Boolean).join(' · ');
  return h('a', { class: 'card', href: `#/item/${it.id}` },
    thumb(art(it.id, 'backdrop'), it.title, it),
    h('div', { class: 't' }, it.title), h('div', { class: 's' }, sub));
}

function showCard(show) {
  const left = show.episodes.filter((e) => !e.watched).length;
  const seasons = new Set(show.episodes.map((e) => e.season)).size;
  return h('a', { class: 'card', href: `#/show/${show.key}` },
    thumb(art(show.episodes[0].id, 'backdrop'), show.name, null, left ? h('span', { class: 'badge' }, String(left)) : null),
    h('div', { class: 't' }, show.name),
    h('div', { class: 's' }, `${plural(seasons, 'season')} · ${plural(show.episodes.length, 'episode')}`));
}

// A card that starts playback straight away (Continue watching, search hits).
function playCard(it) {
  const isEp = it.type === 'episode';
  const left = it.position ? `${runtime(it.duration - it.position)} left` : runtime(it.duration);
  return h('a', { class: 'card', href: `#/play/${it.id}` },
    thumb(art(it.id), isEp ? it.show : it.title, it),
    h('div', { class: 't' }, isEp ? it.show : it.title),
    h('div', { class: 's' }, isEp ? `${epCode(it)} · ${it.title}` : left));
}

function section(title, cards, count) {
  if (!cards.length) return null;
  return h('section', { class: 'section' },
    h('h2', {}, title, count ? h('small', {}, String(count)) : null),
    h('div', { class: 'row' }, cards));
}

// -------------------------------------------------------------------- views

function hero({ bg, eyebrow, title, meta, actions, poster, filename }) {
  return h('div', { class: 'hero' },
    h('div', { class: 'bg', style: `background-image:url("${bg}")` }),
    poster ? h('img', { class: 'poster', src: poster, alt: '' }) : null,
    h('div', { class: 'info' },
      eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null,
      h('h1', {}, title),
      h('div', { class: 'meta' }, meta),
      h('div', { class: 'actions' }, actions),
      filename ? h('div', { class: 'filename' }, filename) : null));
}

function playButton(it, label) {
  const text = label || (it.position > 15 ? `Resume from ${clock(it.position)}` : 'Play');
  return h('a', { class: 'btn primary', href: `#/play/${it.id}`, html: ICON.play }, text);
}

function itemMeta(it) {
  return [
    it.year ? h('span', {}, String(it.year)) : null,
    h('span', {}, runtime(it.duration)),
    h('span', { class: 'tag' }, quality(it)),
    it.playback === 'direct' ? null : h('span', { class: 'tag', title: 'This file is converted on the fly while you watch' }, it.playback === 'remux' ? 'Remux' : 'Transcode'),
    it.subs.length ? h('span', { class: 'tag' }, 'CC') : null,
    it.watched ? h('span', { class: 'check' }, '✓ Watched') : null,
  ];
}

function emptyState() {
  const scanning = S.status.scanning;
  return h('div', { class: 'empty' },
    h('h1', {}, scanning ? 'Scanning your library…' : 'Nothing to watch yet'),
    scanning
      ? h('p', {}, `${S.status.done} of ${S.status.total} files checked.`)
      : [h('p', {}, 'Drop video files into a media folder, then press Rescan. SunFlix is watching:'),
        S.mediaDirs.map((d) => h('code', {}, d)),
        h('p', {}, 'Name movies like “Title (2021).mkv” and episodes like “Show S01E02.mkv” so they sort themselves out.')]);
}

function viewHome() {
  if (!S.items.length) return emptyState();
  const recent = [...S.items].sort((a, b) => b.addedAt - a.addedAt);
  const feature = S.cont[0] || recent[0];
  const isEp = feature.type === 'episode';
  const seen = new Set();
  const recentCards = [];
  for (const it of recent) {
    const key = it.type === 'episode' ? `s:${it.showKey}` : it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    recentCards.push(it.type === 'episode' ? showCard(S.shows.get(it.showKey)) : movieCard(it));
    if (recentCards.length === 18) break;
  }
  const allMovies = movies().sort((a, b) => byTitle(a.title, b.title));
  const allShows = [...S.shows.values()].sort((a, b) => byTitle(a.name, b.name));
  return [
    hero({
      bg: art(feature.id, 'backdrop'),
      eyebrow: S.cont[0] ? 'Continue watching' : 'Just added',
      title: isEp ? feature.show : feature.title,
      meta: isEp ? [h('span', {}, `${epCode(feature)} · ${feature.title}`), ...itemMeta(feature).slice(1)] : itemMeta(feature),
      actions: [playButton(feature), h('a', { class: 'btn', href: isEp ? `#/show/${feature.showKey}` : `#/item/${feature.id}` }, 'Details')],
    }),
    section('Continue watching', S.cont.map(playCard)),
    section('Recently added', recentCards),
    section('Movies', allMovies.slice(0, 24).map(movieCard), allMovies.length),
    section('Shows', allShows.slice(0, 24).map(showCard), allShows.length),
  ];
}

function viewGrid(title, cards) {
  if (!S.items.length) return emptyState();
  return [h('h1', { class: 'page-title' }, title),
    cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'empty' }, h('p', {}, `No ${title.toLowerCase()} found.`))];
}

function viewItem(id) {
  const it = S.byId.get(id);
  if (!it) return viewMissing();
  const isEp = it.type === 'episode';
  const setWatched = async (watched) => { await api(`/api/watched/${it.id}`, { watched }); await refresh(); };
  return [hero({
    bg: art(it.id, 'backdrop'),
    poster: it.hasPoster ? art(it.id, 'poster') : null,
    eyebrow: isEp ? `${it.show} · ${epCode(it)}` : null,
    title: it.title,
    meta: itemMeta(it),
    filename: it.file,
    actions: [
      playButton(it),
      it.position > 15 ? h('a', { class: 'btn', href: `#/play/${it.id}?t=0` }, 'Start over') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => setWatched(!it.watched) }, it.watched ? 'Mark unwatched' : 'Mark watched'),
      isEp ? h('a', { class: 'btn', href: `#/show/${it.showKey}` }, 'All episodes') : null,
    ],
  })];
}

function viewShow(key, query) {
  const show = S.shows.get(key);
  if (!show) return viewMissing();
  const seasons = [...new Set(show.episodes.map((e) => e.season))];
  const up = show.episodes.find((e) => !e.watched) || show.episodes[0];
  let current = Number(query.get('s'));
  if (!query.has('s') || !seasons.includes(current)) current = up.season;
  const seasonName = (n) => (n === 0 ? 'Specials' : `Season ${n}`);
  const first = show.episodes[0];
  return [
    hero({
      bg: art(first.id, 'backdrop'),
      poster: first.hasPoster ? art(first.id, 'poster') : null,
      title: show.name,
      meta: [show.year ? h('span', {}, String(show.year)) : null,
        h('span', {}, plural(seasons.length, 'season')), h('span', {}, plural(show.episodes.length, 'episode'))],
      actions: [playButton(up, up.position > 15 ? `Resume ${epCode(up)}` : `Play ${epCode(up)}`)],
    }),
    seasons.length > 1 ? h('div', { class: 'seasons' }, seasons.map((n) =>
      h('button', { type: 'button', class: n === current ? 'on' : '', onclick: () => { location.replace(`#/show/${key}?s=${n}`); } }, seasonName(n)))) : null,
    h('div', { class: 'episodes' }, show.episodes.filter((e) => e.season === current).map((e) =>
      h('a', { class: 'ep', href: `#/play/${e.id}` },
        h('div', { class: 'n' }, String(e.episode)),
        thumb(art(e.id), e.title, e),
        h('div', {},
          h('h3', {}, e.title, e.watched ? h('span', { class: 'check' }, ' ✓') : null),
          h('p', {}, [runtime(e.duration), quality(e), e.position > 15 ? `${runtime(e.duration - e.position)} left` : null].filter(Boolean).join(' · ')))))),
  ];
}

function viewSearch(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return viewHome();
  const hit = (s) => (s || '').toLowerCase().includes(needle);
  const m = movies().filter((it) => hit(it.title)).map(movieCard);
  const s = [...S.shows.values()].filter((show) => hit(show.name)).map(showCard);
  const e = S.items.filter((it) => it.type === 'episode' && hit(it.title)).slice(0, 40).map(playCard);
  const cards = [...s, ...m, ...e];
  return [h('h1', { class: 'page-title' }, `Results for “${q.trim()}”`),
    cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'empty' }, h('p', {}, 'Nothing in your library matches that.'))];
}

function viewMissing() {
  return h('div', { class: 'empty' }, h('h1', {}, 'Not found'),
    h('p', {}, 'That video is no longer in the library.'), h('a', { class: 'btn', href: '#/' }, 'Back home'));
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
  input, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), err);
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
  const P = { mode: item.playback === 'direct' ? 'direct' : 'transcode', offset: 0, target: 0, audio: 0, cues: [], dragging: false, done: false };

  const video = h('video', { playsinline: true, preload: 'auto' });
  const cueBox = h('div', { class: 'cues' });
  const spin = h('div', { class: 'spin' });
  const big = h('button', { class: 'bigplay', type: 'button', 'aria-label': 'Play', html: ICON.play, hidden: true });
  const msg = h('div', { class: 'pmsg', hidden: true });
  const playBtn = h('button', { class: 'icon', type: 'button', 'aria-label': 'Play or pause', html: ICON.pause });
  const muteBtn = h('button', { class: 'icon', type: 'button', 'aria-label': 'Mute', html: ICON.vol });
  const cur = h('span', { class: 'time' }, '0:00');
  const seekBar = h('input', { class: 'seek', type: 'range', min: 0, max: Math.max(1, Math.floor(dur)), step: 1, value: 0, 'aria-label': 'Seek' });
  const vol = h('input', { class: 'vol', type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  const subSel = item.subs.length ? h('select', { 'aria-label': 'Subtitles' },
    h('option', { value: '' }, 'Subtitles off'),
    item.subs.map((s, i) => h('option', { value: s.key }, langLabel(s, `Track ${i + 1}`)))) : null;
  const audSel = item.audio.length > 1 ? h('select', { 'aria-label': 'Audio track' },
    item.audio.map((a, i) => h('option', { value: i }, langLabel(a, `Audio ${i + 1}`)))) : null;
  const upNext = next ? h('a', { class: 'btn primary upnext', href: `#/play/${next.id}?t=0`, hidden: true }, `Next: ${epCode(next)}`) : null;
  const exit = () => { location.hash = isEp ? `#/show/${item.showKey}?s=${item.season}` : `#/item/${item.id}`; };

  const root = h('div', { class: 'player' },
    video, spin, big, msg, cueBox, upNext,
    h('div', { class: 'ptop' },
      h('button', { class: 'icon', type: 'button', 'aria-label': 'Back', html: ICON.back, onclick: exit }),
      h('div', { class: 'ptitle' }, isEp ? item.show : item.title,
        h('small', {}, isEp ? `${epCode(item)} · ${item.title}` : [item.year, quality(item)].filter(Boolean).join(' · ')))),
    h('div', { class: 'pbot' },
      seekBar,
      h('div', { class: 'controls' },
        playBtn,
        h('button', { class: 'icon', type: 'button', 'aria-label': 'Back 10 seconds', html: ICON.rew, onclick: () => seek(now() - 10) }),
        h('button', { class: 'icon', type: 'button', 'aria-label': 'Forward 10 seconds', html: ICON.fwd, onclick: () => seek(now() + 10) }),
        cur, h('span', { class: 'time' }, `/ ${clock(dur)}`),
        h('span', { class: 'spacer' }),
        audSel, subSel, muteBtn, vol,
        h('button', { class: 'icon', type: 'button', 'aria-label': 'Fullscreen', html: ICON.full, onclick: fullscreen }))));

  const now = () => (P.mode === 'direct' ? video.currentTime : P.offset + video.currentTime);
  const clamp = (t) => Math.max(0, Math.min(t, Math.max(0, dur - 2)));

  let loads = 0;
  async function load(t) {
    t = clamp(t);
    const mine = ++loads;
    P.target = t;
    spin.hidden = false;
    msg.hidden = true;
    if (P.mode === 'direct') {
      P.offset = 0;
      video.src = `/stream/${item.id}`;
      if (t > 0) video.addEventListener('loadedmetadata', () => { if (mine === loads) video.currentTime = t; }, { once: true });
    } else {
      video.pause();
      // Copied video can only start on a keyframe, so ask where this stream will really begin.
      const real = t > 0 ? await api(`/api/start/${item.id}?t=${t.toFixed(3)}`).then((r) => r.start, () => t) : 0;
      if (mine !== loads || P.done) return; // a newer seek, or the player closed, while we waited
      P.offset = real;
      video.src = `/transcode/${item.id}?t=${real.toFixed(3)}&a=${P.audio}`;
    }
    video.play().catch(() => { if (mine === loads) { big.hidden = false; spin.hidden = true; } });
  }

  function seek(t) {
    t = clamp(t);
    if (P.mode === 'direct') video.currentTime = t;
    else load(t);
    paint(t);
  }

  function paint(t) {
    cur.textContent = clock(t);
    if (!P.dragging) seekBar.value = t;
    seekBar.style.setProperty('--p', `${dur ? (Number(seekBar.value) / dur) * 100 : 0}%`);
  }

  function toggle() {
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  }

  function report(position) {
    if (P.done) return Promise.resolve();
    const t = position == null ? now() : position;
    if (!(t > 0)) return Promise.resolve();
    return api(`/api/progress/${item.id}`, { position: t }).catch(() => {});
  }

  let idleTimer = null;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) root.classList.add('idle'); }, 3000);
  }

  video.addEventListener('timeupdate', () => {
    const t = now();
    if (t >= P.target) P.target = 0;
    paint(t);
    const cue = P.cues.find((c) => t >= c.start && t <= c.end);
    cueBox.replaceChildren(cue ? h('span', {}, cue.text) : '');
    if (upNext) upNext.hidden = !(dur && dur - t < 30);
  });
  video.addEventListener('playing', () => { spin.hidden = true; big.hidden = true; playBtn.innerHTML = ICON.pause; wake(); });
  video.addEventListener('waiting', () => { spin.hidden = false; });
  video.addEventListener('pause', () => { playBtn.innerHTML = ICON.play; root.classList.remove('idle'); report(); });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    const t = Math.max(now(), P.target);
    if (P.mode === 'direct') { P.mode = 'transcode'; load(t); return; } // let the server convert it instead
    spin.hidden = true;
    msg.hidden = false;
    msg.textContent = 'This video could not be played. The file may be damaged or use a format ffmpeg cannot read.';
  });
  video.addEventListener('ended', async () => {
    const finished = !dur || now() > dur * 0.92;
    if (!finished) return; // stream cut short; leave the viewer where they were
    await report(dur);
    P.done = true;
    if (next) location.hash = `#/play/${next.id}?t=0`; else exit();
  });

  playBtn.addEventListener('click', toggle);
  big.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', fullscreen);
  seekBar.addEventListener('input', () => { P.dragging = true; cur.textContent = clock(seekBar.value); seekBar.style.setProperty('--p', `${dur ? (seekBar.value / dur) * 100 : 0}%`); });
  seekBar.addEventListener('change', () => { P.dragging = false; seek(Number(seekBar.value)); });
  vol.addEventListener('input', () => { video.volume = Number(vol.value); video.muted = false; });
  muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
  video.addEventListener('volumechange', () => {
    muteBtn.innerHTML = video.muted || !video.volume ? ICON.mute : ICON.vol;
    try { localStorage.setItem('sunflix-volume', String(video.volume)); } catch { /* private mode */ }
  });
  if (subSel) subSel.addEventListener('change', async () => {
    P.cues = [];
    cueBox.replaceChildren();
    if (!subSel.value) return;
    try {
      const res = await fetch(`/subs/${item.id}/${subSel.value}`);
      if (!res.ok) throw new Error();
      P.cues = parseVtt(await res.text());
    } catch { subSel.value = ''; }
  });
  if (audSel) audSel.addEventListener('change', () => {
    const t = now();
    P.audio = Number(audSel.value);
    P.mode = P.audio === 0 && item.playback === 'direct' ? 'direct' : 'transcode'; // only the server can switch tracks
    load(t);
  });

  function onKey(e) {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'arrowleft') seek(now() - 10);
    else if (k === 'arrowright') seek(now() + 10);
    else if (k === 'f') fullscreen();
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'escape' && !document.fullscreenElement) exit();
    else return;
    e.preventDefault();
    wake();
  }
  const onLeave = () => {
    if (P.done || !(now() > 0)) return;
    navigator.sendBeacon(`/api/progress/${item.id}`, new Blob([JSON.stringify({ position: now() })], { type: 'application/json' }));
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', onLeave);
  root.addEventListener('pointermove', wake);
  root.addEventListener('pointerdown', wake);
  const ticker = setInterval(() => { if (!video.paused) report(); }, 10000);

  try {
    const saved = Number(localStorage.getItem('sunflix-volume'));
    if (saved > 0 && saved <= 1) { video.volume = saved; vol.value = saved; }
  } catch { /* private mode */ }

  document.body.classList.add('playing');
  app.replaceChildren(root);
  const resume = query.has('t') ? Number(query.get('t')) || 0 : (item.position > 15 && item.position < dur - 15 ? item.position : 0);
  load(resume);
  wake();

  return {
    async destroy() {
      clearInterval(ticker);
      clearTimeout(idleTimer);
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
  const keep = window.scrollY;
  app.replaceChildren(...[view].flat().filter(Boolean));
  if (render.last !== route) window.scrollTo(0, 0); else window.scrollTo(0, keep);
  render.last = route;
}

window.addEventListener('hashchange', render);

document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value;
  const target = q.trim() ? `#/search?q=${encodeURIComponent(q)}` : '#/';
  if (location.hash.startsWith('#/search')) location.replace(target); else location.hash = target;
});

document.getElementById('rescan').addEventListener('click', async () => {
  await api('/api/scan', {}).catch(() => {});
  refresh().catch(() => {});
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  showLogin();
});

refresh().catch((err) => {
  if (!document.body.classList.contains('locked')) {
    app.replaceChildren(h('div', { class: 'empty' }, h('h1', {}, 'Cannot reach SunFlix'), h('p', {}, err.message)));
  }
});
