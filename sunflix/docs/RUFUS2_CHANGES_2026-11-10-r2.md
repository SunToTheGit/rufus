# Rufus2 r2 changes, 2026-11-10

Implements all five items from `docs/RUFUS_AUDIT_2026-11-10-r2.md`, all in
the player. `openPlayer` in `public/app.js` and the player block in
`public/style.css` were rebuilt; streaming, transcoding, resume and progress
reporting are untouched underneath.

## 1. The scrub bar is a form control

`public/app.js` (timeline section of `openPlayer`), `lib/media.js`
(`preview`), `server.js` (`/preview/:id`).

The range input is gone. The timeline is a `role="slider"` element with
played and buffered fills, a knob that appears on hover, and a tip that
follows the pointer with the time and a preview frame. Frames come from the
new `/preview/:id?t=` endpoint, snapped to a time bucket (at most ~240 per
video) and cached on disk; the client only requests the frame the pointer
settles on. Elapsed sits under the left end, time remaining under the right.

## 2. Subtitles and audio are two native selects in the toolbar

Transport moved to the centre of the screen at full size. Back, title,
next episode, the menu, volume and fullscreen sit along the top. Audio and
subtitles are one popover with checked rows (`drawMenu`, `setSub`,
`setAudio`); arrow keys walk it and Escape closes it. The subtitle language
is stored and re-applied on the next video that has it.

## 3. Pause shows nothing, and the first seconds are a spinner on black

The `<video>` now carries the backdrop as its poster, so loading shows the
artwork behind the spinner. Pausing dims the frame and raises a title card
(`.pinfo`): show and episode, title, time left. Subtitles move up out of
its way. The card does not flash during the brief pause while a transcoded
stream restarts for a seek (`P.loading`).

## 4. "Up next" is a button, then a hard cut

An up-next card (`.upcard`) appears in the last 25 seconds with the next
episode's frame, number and title, a live countdown, **Play now** and
**Not now**. Not now cancels autoplay for this video; when it ends the
player returns to the episode list.

## 5. Keyboard and touch are second-class

`onKey` gained ↑/↓ volume, C for subtitles, 0-9 to jump, and every action
that has no other visible result now flashes a confirmation bezel (`flash`).
On touch a tap shows or hides the controls instead of pausing; the centre
button plays and pauses. Escape closes the menu before it leaves the player.

## Verification

- `npm test`: 4 pass. `node --check` clean on all three JS files.
- Headless Chromium, demo library: hover preview loads the right bucket,
  drag-to-seek lands, menu selection and stored preference, Escape order,
  bezel text for every key, cue shown after a jump, pause card, up-next
  shown then declined (lands on the episode list) and accepted (next
  episode plays), emulated iPhone taps (show, hide, centre button pauses).
  No console errors.
- Regression, mixed-format library: direct play, subtitles, resume,
  autoplay, remux and transcode playback with seeking and audio switching
  through the new menu. No stray ffmpeg processes afterwards.
- Em-dash audit on touched files: none in user-rendered strings.
- No deploy target for this project.

## What's still queued

- r1 item 5 remainder: the spotlight pager is not reachable with arrow keys.
- No skip-intro or chapter markers; SunFlix has no data to drive them.
- Preview frames are made on demand, so the first hover on a large 4K
  file can take a second. Pre-generating a sprite at scan time would fix it.
- Picture-in-picture and playback speed were left out on purpose (Law 4).
- Still not tested in Safari or on a TV browser.

Recommendation: the loop is done for pure design. The next real gain is
metadata (synopses, title art, cast), which is a product decision.
