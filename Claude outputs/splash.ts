// Splash screen controller. The markup and styles live inline in index.html
// so the splash paints on the first frame, before this bundle has loaded.
// App.tsx calls hideSplash() once the first real screen (PIN, setup or the
// set screen) has what it needs; the splash then stays up until it has been
// visible for at least MIN_VISIBLE_MS (so it reads as intentional rather
// than a flicker on a fast LAN) and the display font has loaded (so the
// wordmark doesn't swap typefaces mid-fade), then fades out and is removed.

const MIN_VISIBLE_MS = 1200;
const FONT_WAIT_CAP_MS = 1500;

let hiding = false;

export function hideSplash(): void {
  if (hiding) return;
  hiding = true;

  const el = document.getElementById("splash");
  if (!el) return;

  // performance.now() is measured from navigation start, i.e. roughly when
  // the splash first painted.
  const minWait = new Promise<void>((resolve) =>
    setTimeout(resolve, Math.max(0, MIN_VISIBLE_MS - performance.now()))
  );
  const fontWait = Promise.race([
    document.fonts?.ready ?? Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, FONT_WAIT_CAP_MS)),
  ]);

  Promise.all([minWait, fontWait]).then(() => {
    el.classList.add("out");
    // Remove after the CSS fade (0.45s) so it can't intercept taps or be
    // read out by screen readers. The fallback timer covers reduced-motion,
    // where there's no transition and transitionend never fires.
    const remove = () => el.remove();
    el.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 600);
  });
}
