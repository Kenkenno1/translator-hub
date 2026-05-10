/**
 * 即時翻譯 PWA — Service Worker
 *
 * Strategy:
 *   - Cache the app shell (HTML/CSS/JS/manifest/icons) on install.
 *   - Serve shell cache-first so the PWA opens instantly even offline.
 *   - For everything else (OpenAI API, Cloudflare Worker), bypass entirely —
 *     these need fresh requests with auth headers and ephemeral tokens.
 */

// =============================================================================
// IMPORTANT: bump CACHE_NAME on every shell change.
// =============================================================================
// SHELL_FILES below are cached at install time and served cache-first by the
// fetch handler. If you edit any of those files (index.html, app.js, styles.css,
// manifest, icons, or sw.js itself) but DON'T bump CACHE_NAME, installed PWAs
// will keep serving the old shell from cache `voice-translator-v1` forever.
//
// Convention: bump the integer suffix every time you change anything in
// SHELL_FILES. Use the same date format the project uses elsewhere if you
// prefer a date-based scheme (e.g., 'voice-translator-2026-05-10').
//
// On activate, this SW deletes any cache whose name doesn't match the current
// CACHE_NAME (see activate handler), so old caches are pruned automatically
// once the new SW takes over.
// =============================================================================
const CACHE_NAME = 'voice-translator-v9';

const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('voice-translator-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Bypass non-GET (e.g. POST to Worker / OpenAI)
  if (req.method !== 'GET') return;

  // Bypass cross-origin (OpenAI API, Cloudflare Worker)
  if (url.origin !== self.location.origin) return;

  // Cache-first for our own origin (the shell)
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        // Only cache successful basic responses
        if (fresh.ok && fresh.type === 'basic') {
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        // If we have an offline fallback for navigation, serve index
        if (req.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })(),
  );
});
