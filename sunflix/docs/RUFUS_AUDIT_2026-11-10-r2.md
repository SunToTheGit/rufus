# Rufus design audit r2, 2026-11-10

Scoped to the player, as asked. r1 dressed the lobby; this round is the
room people actually sit in.

## 1. Score carryover

1. **The header is a lid on the picture — VERIFIED.** `public/style.css:34`
   `.top` is `position: fixed` over a scrim; `:41` `.top.solid` is applied
   by `onScroll` in `public/app.js`. Hero is full-bleed (`style.css:80`) and
   the first shelf tucks in (`style.css:112`).
2. **Every title is a 16:9 frame grab — VERIFIED.** `posterCard`
   (`app.js:134`) with the typeset fallback (`style.css:153`); `shelf`
   (`app.js:159`) with paddles (`style.css:125`); resized artwork in
   `lib/media.js:46` `art()` behind the width allow-list at `server.js:291`.
3. **Static hero, dead-end detail page — VERIFIED.** Rotating `hero`
   (`app.js:181`, timer at `:208`), `facts` (`app.js:304`), related shelves
   at `app.js:337` and `:367`.
4. **Ban-list items — VERIFIED.** `style.css:43` wordmark is solid
   `--sun`; `--ink`/`--paper` tokens at `style.css:2,6`; no `#000`/`#fff`
   left in the stylesheet.
5. **Nothing moves, can't drive from the couch — PARTIAL.** Cross-fade
   (`app.js:687`), image fade (`style.css:30`), and `moveFocus`
   (`app.js:697`) all landed. But the selector at `app.js:698` leaves out
   the spotlight pager, and none of it reaches inside the player. The
   player half is this round's item 5; the pager stays queued.

## 2. Trend

Still finding real gaps, not taste. r1's own changes doc admitted the
player "kept its layout; only its colours changed", and it shows: the
browse side now looks like a streaming app and then hands you to a default
video toolbar with the corners rounded. The issues are getting narrower
(one screen instead of the whole shell) but not shallower. The loop is
earning its keep for one more round. After this, what is left is the
metadata problem (no synopses, no title art), and that is a product
decision, not an audit finding.

## 3. Next top 5 priority

### 1. The scrub bar is a form control

**WHAT** — `public/app.js:446` the timeline is `<input type="range">`,
4px tall (`public/style.css:221`), with no hover time, no preview, no
buffered range. The only way to learn what is at a point in the film is to
seek there and wait.

**WHY** — Scrubbing is the most-used control after play. Every streaming
player answers "what's there?" before you commit, because a wrong seek on a
transcoded file costs a restart of the stream. Feedback before commitment.

**FIX** — Custom timeline: taller hit area, played + buffered fills, a knob
that appears on hover, and a tip that follows the pointer with the time and
a preview frame. New `/preview/:id?t=` endpoint returns a small cached frame
snapped to a time bucket so a film costs at most ~240 thumbnails. Elapsed
on the left, time remaining on the right.

### 2. Subtitles and audio are two native `<select>`s in the toolbar

**WHAT** — `public/app.js:448` and `:451` drop OS-styled dropdowns into
the control row (`:464`). Every control in that row has the same visual
weight, play included.

**WHY** — Native selects open a system menu that ignores the player's
look, and on a TV browser they are close to unusable. A flat row of eight
equal controls fails Hick's Law: the one action people take 95% of the time
is the same size as fullscreen.

**FIX** — Transport (back 10, play/pause, forward 10) moves to the centre
at real size. Secondary controls move to the top-right. Audio and subtitles
become one "Audio and subtitles" popover with checked rows. The subtitle
choice is remembered and re-applied on the next video.

### 3. Pause shows nothing, and the first seconds are a spinner on black

**WHAT** — `public/app.js:438` the `<video>` has no poster, so loading is
`.spin` (`:440`) on an empty screen. On pause the only change is the icon.

**WHY** — Pause is when people look away and come back; the screen should
say what this is and how much is left. And a black frame while a transcode
spins up reads as "broken" for the first two seconds.

**FIX** — Backdrop as the video poster. On pause, dim the frame and bring up
a title card over the timeline: show and episode, title, time left.

### 4. "Up next" is a button, then a hard cut

**WHAT** — `public/app.js:453` a lone `Next: S1 E4` pill appears 30s from
the end (`:541`); at `ended` (`:554`) the player jumps to the next episode
with no warning and no way to decline.

**WHY** — Autoplay that cannot be refused is the single most complained
about behaviour in streaming. And a text pill gives no sense of what is
about to start.

**FIX** — An up-next card in the last 25 seconds: thumbnail, episode
number and title, a live "Starts in Ns", **Play now** and **Not now**.
Not now cancels autoplay for this video and the player returns to the
episode list when it ends.

### 5. Keyboard and touch are second-class

**WHAT** — `public/app.js:591` `onKey` handles six keys and gives no
visual feedback: press → and nothing confirms the jump. No volume keys, no
subtitle key, no number-key jumps. `:564` a tap on the video toggles
playback, so on a phone the first tap, the one meant to reveal the
controls, pauses the film.

**WHY** — From the couch the keyboard is the remote; an unacknowledged
key press gets pressed again. On touch, "tap to show controls" is the
universal convention and breaking it makes the player feel hostile.

**FIX** — A brief confirmation bezel for seeks, volume, mute and
subtitles. Add ↑/↓ volume, C for subtitles, 0-9 to jump by tenths. On
touch, a tap shows or hides the controls and the centre button plays.
Escape closes the menu before it leaves the player.

---

Lens: `sunny-steve-jobs` loaded. `impeccable`, `ui-ux-pro-max`, `critique`
still missing (gstack not installed), inlined rules applied.
