// Verastar service worker — app shell ONLY.
//
// Purpose: make the web app installable (home-screen icon, standalone window) and
// give it a launchable shell when the network is flaky. It deliberately caches
// NOTHING else: library data lives in the account/IndexedDB, and every PubMed /
// Anthropic / Supabase request must hit the network untouched — a digest can't be
// cached into correctness, and a stale bundle would hide a deploy. Push
// notifications: parked, on purpose.
//
// Bump VERSION when the shell list changes; activate cleans old caches.

const VERSION = 'v1'
const CACHE = `verastar-shell-${VERSION}`
const SHELL = ['/', '/site.webmanifest', '/icon.svg', '/favicon.png', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Navigations: network-first so a deploy is never masked; the cached shell is
  // only the fallback for a flaky launch. The fresh copy re-primes the cache.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  // Shell assets (icons, manifest): cache-first — they change only with VERSION.
  if (url.origin === self.location.origin && SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(event.request)))
  }
  // Everything else (hashed bundles, PubMed, Anthropic, Supabase): untouched.
})
