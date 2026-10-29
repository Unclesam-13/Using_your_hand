const CACHE = "hand-pulse-v3";
const PRECACHE = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/tracker.js",
  "./js/audio.js",
  "./manifest.webmanifest",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 网络优先，离线时回退缓存
  event.respondWith(fromNetwork(req));
});

function store(req, res) {
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
}

function fromNetwork(req) {
  return fetch(req)
    .then((res) => {
      store(req, res);
      return res;
    })
    .catch(() => caches.match(req).then((cached) => cached || Response.error()));
}
