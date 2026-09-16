// Minimal service worker (spec §11) — just enough for "Add to Home Screen"
// to install in standalone mode, plus network-first caching of the app shell
// so a flaky home wifi doesn't blank the screen. API calls always go live.
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
