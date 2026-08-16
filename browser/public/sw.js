// Openworks AI service worker — cache shell + offline fallback + web push
const CACHE = "openworks-ai-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png"];

// Web Push: show the notification, and on click focus an existing tab (or open
// one) at the payload's url — typically /?item=<jobId> to deep-link the item.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || "Openworks", {
      body: data.body || "",
      data: { url: data.url || "/" },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.url || "openworks",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          if ("navigate" in c) {
            try {
              await c.navigate(target);
            } catch {
              /* not allowed — just focus */
            }
          }
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Don't intercept Convex websockets / cross-origin API calls
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  // Network-first for HTML and JS (so updates land), fallback to cache
  if (e.request.mode === "navigate" || url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
    );
    return;
  }

  // Cache-first for everything else (images, fonts, manifest)
  e.respondWith(
    caches.match(e.request).then(
      (r) =>
        r ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }),
    ),
  );
});
