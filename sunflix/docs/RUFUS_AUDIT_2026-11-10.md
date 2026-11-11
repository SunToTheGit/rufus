# Rufus design audit r1, 2026-11-10

First pass on SunFlix. The brief: make it feel like a living-room streaming
app (the Apple TV / Netflix school) instead of a file browser with a nice
palette. The plumbing is sound. The front of house is a tidy admin page.

## 1. Score carryover

Skipped — r1.

## 2. Trend

No trajectory yet, so a baseline. Nothing here is broken; everything here is
timid. The shipped UI answers "what files do I have" when a streaming app
answers "what do I want to watch tonight". Every finding below is the same
finding wearing a different hat: the picture is not in charge. The chrome
sits on top of it, the cards shrink it, the detail page ends before it
starts. This round is structural, not polish. Expect r2 to be taste.

One self-own: the gradient-text wordmark and the pure-black player both
shipped in the first commit. Both are on the ban list. See item 4.

## 3. Next top 5 priority

### 1. The header is a lid on the picture

**WHAT** — `public/style.css:32` `.top` is a sticky, opaque bar with a border.
`public/style.css:69` `.hero` starts underneath it and is capped at
`min(62vh, 560px)`. The first shelf starts on a hard edge below the hero.

**WHY** — Cinematic UIs are full-bleed. The artwork runs to the top of the
glass and the navigation floats on it. A lid above the hero tells the eye
"website", and the cap leaves a third of the screen for rows nobody has
looked at yet. Hierarchy: the one thing to watch tonight should own the
first screen.

**FIX** — Navigation becomes `position: fixed`, transparent over a top
scrim, and only takes a tinted solid background once the page has scrolled.
Hero goes full-bleed at ~80vh. The first shelf tucks up into the hero's
bottom fade so the page reads as one surface. Rescan drops from a labelled
button to an icon: it is a once-a-month action sitting at primary nav
weight (Law 4).

### 2. Every title is a 16:9 frame grab with a caption under it

**WHAT** — `public/app.js:124` `movieCard` and `public/app.js:131` `showCard`
render the same landscape thumbnail + two lines of text for everything, in
every row. `hasPoster` is known to the client and ignored outside the detail
page. `public/style.css:87` `.row` shows a native scrollbar and has no way to
page with a mouse.

**WHY** — Identical cards in identical rows is the "a script made this list"
pattern. Streaming apps use shape to carry meaning: portrait posters mean
"a title", landscape stills mean "a moment you were in". Posters also carry
their own typography, so the caption underneath is redundant noise. And a
shelf you can only scroll with a trackpad is a shelf half the audience
cannot use.

**FIX** — Poster shelves (2:3) for movies and shows; landscape cards only
for Continue watching and episodes. No poster on disk: crop the frame to
2:3 and typeset the title on it, so the shelf still reads as a shelf.
Shelves hide their scrollbar and grow paddle buttons at the edges that
appear only when there is more to see. Serve artwork resized
(`lib/media.js:49` hard-codes 640px for frames and ships posters at full
size).

### 3. The hero is one static title, and the detail page is a dead end

**WHAT** — `public/app.js:198` `viewHome` features exactly one item forever.
`public/app.js:235` `viewItem` returns a hero and nothing else: the page
ends at the buttons. Backdrops fall back to a 640px frame stretched across
the whole viewport.

**WHY** — The billboard is the most valuable square metre in the app and it
never changes. And a detail page with nowhere to go next makes "back" the
only option, which is how sessions end.

**FIX** — Home hero becomes a spotlight that rotates through up to five
titles (what you were watching, then the newest), with a pager, pausing on
hover/focus and standing still under reduced motion. Movie pages get a
quiet facts line and a "More movies" shelf; show pages get "More shows".
Backdrops are requested at 1920px.

### 4. Ban-list items shipped in the first commit

**WHAT** — `public/style.css:41` `.logo b` is gradient text via
`background-clip: text`. `public/style.css:136-137` the player is pure
`#000`; `public/style.css:147,156-157` icons and slider thumbs are pure
`#fff`. Primary buttons are an orange gradient pill.

**WHY** — Gradient text is the single most recognisable machine-made design
tell. Pure black and white ignore the warm hue the rest of the palette is
built on, so the player feels like a different product. The gradient pill
competes with the artwork for the warmest pixel on screen.

**FIX** — Solid sun-coloured wordmark. Introduce `--ink` (warm near-black)
and `--paper` (warm near-white) tokens and use them everywhere pure values
were. Primary action becomes a solid paper-coloured button, which is the
convention on a dark cinematic surface; the sun colour is kept for
progress, focus and the eyebrow, where it means something.

### 5. Nothing moves, and you cannot drive it from the couch

**WHAT** — `public/app.js:591` swaps the whole view with `replaceChildren`
in one frame. Images pop in whenever they finish loading. Arrow keys do
nothing outside the player, and focus styling is the default outline.

**WHY** — A media app is used leaning back. The Apple TV feel is mostly
focus behaviour: the thing you are on lifts, and the next thing is one
arrow press away. Hard cuts and image pop-in read as "loading a web page".

**FIX** — Cross-fade between pages with the View Transitions API where it
exists. Fade artwork in on load. Arrow keys move focus spatially between
cards, shelves and the hero buttons, and the focused card gets the same
lift as hover. All of it off under `prefers-reduced-motion`.

---

Lens: `sunny-steve-jobs` loaded. `impeccable`, `ui-ux-pro-max`, `critique`
missing (gstack could not be installed in this environment), so the inlined
rules stood in for them.
