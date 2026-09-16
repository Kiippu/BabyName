// Minimal service worker (spec §11) — just enough for "Add to Home Screen"
// to install in standalone mode, plus caching of the app shell so a flaky
// home wifi doesn't blank the screen. API calls always go live -- a cached
// round is a blind-reveal bug wearing a performance costume, so /api/ is
// excluded from every strategy below, not just the default one.
const CACHE = "nameplate-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/api/")) return;

  // CO-4 §7: Vite content-hashes every filename under /assets/, so a new
  // build is a new URL -- a cached asset response can never go stale.
  // Cache-first here means most launches answer entirely from the cache,
  // costing nothing on PythonAnywhere's CPU budget (nginx wouldn't even see
  // the request either way, but this also covers local/offline use).
  // index.html (and everything else -- manifest, icons) stays network-first,
  // same as before, since that's the one file a stale cache could actually
  // hurt by serving an old shell forever.
  if (event.request.url.includes("/assets/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const res = await fetch(event.request);
        cache.put(event.request, res.clone());
        return res;
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(event.request);
        cache.put(event.request, res.clone());
        return res;
      } catch {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        throw new Error("offline and not cached");
      }
    })
  );
});
