// Munim service worker: network-first, shell cached only as an offline fallback.
// Never caches API, POST, OAuth, Swiggy, export or verify traffic.
const CACHE = "munim-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon.svg"];
const NEVER = [/^\/api(\/|$)/, /^\/oauth/, /^\/swiggy/, /^\/export\.csv$/, /^\/verify/, /^\/login/, /^\/logout/, /^\/health/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" }))))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;
  const cacheable = SHELL.includes(url.pathname);
  event.respondWith(
    fetch(req).then(
      (res) => {
        // only cache clean 200s, never a login redirect or an error page
        if (cacheable && res.ok && res.status === 200 && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname, copy));
        }
        return res;
      },
      () => caches.match(url.pathname, { ignoreSearch: true }).then((hit) => hit ?? Response.error()),
    ),
  );
});
