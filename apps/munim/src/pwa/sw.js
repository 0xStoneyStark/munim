// Munim service worker: network-first, shell cached only as an offline fallback.
// Never caches API, POST, OAuth, Swiggy, export or verify traffic.
const CACHE = "munim-shell-v3";
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
  // everything that is not part of the cached shell goes straight to the network,
  // untouched: a failed fetch then surfaces as the browser's own error, not ERR_FAILED from us
  if (!cacheable) return;
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

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Munim";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag,
      data: { url: data.url || "/" },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === target) || windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target);
      return open.focus().then((w) => (w && w.url !== target && "navigate" in w ? w.navigate(target) : w));
    }),
  );
});
