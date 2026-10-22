// Entrance replay: cards, gauges and overview figures play their
// entrance again on demand (refresh, skin / layout / mode switch, reopening).
// The CSS animations already exist; rewinding them to 0 replays them with
// their stagger delays. Rewinding never calls play()/pause(), so the CSS
// play-state (off-screen cards, stored panel) keeps control, and with motion
// off there are no animations to rewind.
const ENTRANCE = new Set(['card-in', 'card-in-dial', 'card-in-party', 'curtain-down', 'curtain-fade', 'curtain-side', 'curtain-side-rtl', 'fill-in', 'ring-in',
  'num-pop', 'fade-in']);
const SCOPE = '.provider-card, .overview';

export function replayEntrance(root: HTMLElement | null) {
  if (!root || typeof root.getAnimations !== 'function') return 0;
  let count = 0;
  for (const animation of root.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation) || !ENTRANCE.has(animation.animationName)) continue;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (!(target instanceof Element) || !target.closest(SCOPE)) continue;
    animation.currentTime = 0; count += 1;
  }
  root.dataset.entranceReplays = String(Number(root.dataset.entranceReplays || 0) + 1);
  return count;
}
