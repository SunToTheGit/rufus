# Rufus2 r1 changes, 2026-11-10

Implements all five in-codebase items from `docs/RUFUS_AUDIT_2026-11-10.md`.
No pivot item this round, nothing skipped.

## 1. The header is a lid on the picture

`public/style.css`, `public/index.html`, `public/app.js`.

`.top` is now `position: fixed` over a top scrim and only takes a solid,
blurred background once the page scrolls (`onScroll` toggles `.solid`). The
hero is full-bleed at ~84vh and the first shelf is pulled up 64px into its
bottom fade. Pages without a hero get top padding through `body.has-hero`.
Rescan went from a labelled pill to an icon button that spins while a scan
runs; the empty state keeps a worded "Look again now" button because that is
the one place a new user needs it.

## 2. Every title is a 16:9 frame grab with a caption under it

`public/app.js` (`posterCard`, `playCard`, `shelf`), `lib/media.js`,
`server.js`.

Movies and shows are 2:3 poster cards with no caption. With no poster on
disk the frame is cropped to 2:3 and the title is typeset over a bottom
fade, so a library with zero artwork still reads as shelves. Landscape cards
are kept for Continue watching and episodes only. Shelves hide their
scrollbar and have paddle buttons that appear on hover and only in the
direction that has more. `/art/:id` now takes `kind` (poster, backdrop,
frame) and `w` (400, 640, 1920) and serves a resized, cached JPEG instead of
the original file.

## 3. The hero is one static title, and the detail page is a dead end

`public/app.js` (`hero`, `slideFor`, `viewHome`, `viewItem`, `viewShow`,
`facts`).

The home hero is a spotlight of up to five titles: what was last being
watched, then the newest arrivals, one per title. It advances every 9s,
has a pager, holds still while hovered or focused, while the tab is hidden,
and under reduced motion. Movie pages gained a facts row (video, audio,
subtitles, file) and a "More movies" shelf; show pages a "More shows"
shelf. Backdrops are requested at 1920px.

## 4. Ban-list items shipped in the first commit

`public/style.css`.

Gradient-text wordmark replaced with solid `--sun`. New `--ink` and
`--paper` tokens replace every pure black and white, player included.
Primary action is a solid paper button; secondary actions are translucent
over the artwork. The sun colour now only marks progress, focus-adjacent
accents and the eyebrow.

## 5. Nothing moves, and you cannot drive it from the couch

`public/app.js` (`render`, `moveFocus`, `picture`), `public/style.css`.

Route changes cross-fade through the View Transitions API where the browser
has it (search keystrokes and same-page refreshes swap instantly). Artwork
fades in on load. Arrow keys move focus to the nearest card, episode, season
tab or hero button in that direction, and the focused card gets the hover
lift plus a paper ring. All motion is off under `prefers-reduced-motion`.

## Verification

- `npm test`: 4 pass.
- `node --check public/app.js`: clean.
- Headless Chromium on a 23-video demo library with posters and backdrops:
  home, scrolled shelves, movie page, show page, grid, search, spotlight
  pager, arrow-key navigation trail, 390px phone layout with no horizontal
  overflow, no console errors.
- Regression on the original mixed-format library with no artwork: direct
  play, subtitles, seek, resume, next-episode autoplay, remux and transcode
  playback with seeking and audio switching all still pass; poster fallback
  renders.
- Em-dash audit on touched files: none in user-rendered strings.
- No deploy target for this project.

## What's still queued

- The other three lens skills (impeccable, ui-ux-pro-max, critique) were
  not available this round; r2 should run with them if gstack is installed.
- Titles in the hero are plain text. Real title-treatment art would need
  online metadata, which SunFlix does not fetch.
- The player kept its layout; only its colours changed. It deserves its own
  pass (scrub previews, skip-intro, a proper up-next card).
- Spatial navigation is not yet wired inside the player's controls.
- Not tested in Safari or on a TV browser.
