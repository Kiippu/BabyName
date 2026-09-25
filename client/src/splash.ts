// Cold-launch splash (markup + CSS inlined in index.html so it paints before
// the bundle loads). App.tsx calls hideSplash() once the first real screen
// has its data; the splash then fades and is removed from the DOM.

// Keep it up at least this long after navigation start so a fast LAN load
// doesn't just flicker it.
const MIN_VISIBLE_MS = 1200;
// Wait for webfonts so the wordmark underneath doesn't swap mid-fade — but
// never longer than this after navigation start.
const FONT_WAIT_CAP_MS = 1500;
// Covers reduced motion (no transition, so no transitionend) and missed events.
const REMOVE_FALLBACK_MS = 600;

let hiding = false;
let markGone: () => void = () => {};
const gone = new Promise<void>((resolve) => (markGone = resolve));
if (!document.getElementById("splash")) markGone();

const after = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms - performance.now())));

/** Resolves once the splash is gone from the DOM (immediately if never shown). */
export function whenSplashGone(): Promise<void> {
  return gone;
}

export function hideSplash(): void {
  if (hiding) return;
  hiding = true;
  const el = document.getElementById("splash");
  if (!el) {
    markGone();
    return;
  }
  const fontsReady = Promise.race([document.fonts?.ready ?? Promise.resolve(), after(FONT_WAIT_CAP_MS)]);
  Promise.all([after(MIN_VISIBLE_MS), fontsReady]).then(() => {
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      el.remove();
      markGone();
    };
    el.classList.add("out");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      remove();
      return;
    }
    el.addEventListener("transitionend", (e) => {
      if (e.target === el && e.propertyName === "opacity") remove();
    });
    setTimeout(remove, 450 + REMOVE_FALLBACK_MS);
  });
}
