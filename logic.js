// Minimal logic module for an interactive (non-turn-based) 3D experience.
// The scene runs entirely client-side in index.html; this module just
// satisfies the deploy bundle's entry-point requirement.

export function createInitialState() {
  return { started: true };
}

export function applyMove(state) {
  // No turns — the experience is free-roam orbit/zoom in the browser.
  return state;
}

export function isTerminal() {
  return false;
}
