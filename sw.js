// QR Stock service worker — network first, cache fallback (so the app opens offline)
var CACHE = 'qrstock-v1.6.1';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'rules.js', 'icon.svg', 'manifest.webmanifest',
  'vendor/barcode-detector-3.2.2.js', 'vendor/zxing_reader.wasm'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.url.indexOf('script.google') >= 0) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && req.url.indexOf(self.location.origin) === 0) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () { return caches.match(req); }));
});
