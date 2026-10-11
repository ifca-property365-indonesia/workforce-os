/* Workforce OS service worker: offline shell + Web Push. Pages and API responses are never cached: they hold
   workspace data, and a shared device must not show one user's data to the next. */
const CACHE = "wfos-shell-v1";
const SHELL = ["/offline.html", "/icons/icon-192.png", "/icons/badge-72.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
});

/** How long a window has to say "I showed it" before the system notification is shown anyway. */
const ACK_MS = 500;

/** Offer a push to one window over a MessageChannel; true only when it answers { ack: true } in time. */
function offer(client, msg) {
  return new Promise((resolve) => {
    let ch;
    try {
      ch = new MessageChannel();
    } catch (e) {
      resolve(false);
      return;
    }
    const done = (v) => {
      clearTimeout(timer);
      ch.port1.onmessage = null;
      ch.port1.close();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), ACK_MS);
    ch.port1.onmessage = (e) => done(!!(e.data && e.data.ack === true));
    try {
      client.postMessage(msg, [ch.port2]);
    } catch (e) {
      done(false);
    }
  });
}

self.addEventListener("push", (event) => {
  let data = { title: "Workforce OS", body: "", url: "/dashboard" };
  try {
    data = { ...data, ...event.data.json() };
  } catch (e) {}
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (wins) => {
      // someone may be looking at the app right now: a focused window shows it in-app and says so; without that
      // answer (not focused, an old tab without the listener, too slow) the system notification is shown
      const seen = wins.filter((c) => c.focused || c.visibilityState === "visible");
      const msg = { type: "push", title: data.title, body: data.body, url, tag: data.tag };
      const acks = await Promise.all(seen.map((c) => offer(c, msg)));
      if (acks.some(Boolean)) return;
      return self.registration.showNotification(data.title, { body: data.body, icon: "/icons/icon-192.png", badge: "/icons/badge-72.png", tag: data.tag, data: { url } });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/dashboard", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const w = wins.find((c) => new URL(c.url).origin === url.origin);
      if (w) return w.focus().then(() => w.navigate(url.href));
      return self.clients.openWindow(url.href);
    }),
  );
});
