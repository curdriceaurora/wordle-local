// v9: adds /js/random-name.js to the precache so the new pickRandomName
// global (PR #180) is available offline. app.js calls pickRandomName()
// during startup for both the daily and challenge profile defaults;
// without this entry, a returning offline PWA visitor would fetch a
// fresh /app.js from cache while /js/random-name.js 404s, leaving the
// `pickRandomName` global undefined and the daily/challenge UI broken
// with a ReferenceError before initialization. Codex P2 on PR #180.
//
// v8: invalidates stale app.js so the leaderboard-disabled gate
// (Codex finding on PR #160) and the ensureMetaReady retry-on-failure
// fix (Copilot finding on PR #160) reach returning visitors. Without
// the bump, a daily share URL on Vercel keeps issuing /api/stats/*
// fetches that 404 STATIC_DEPLOY_ENDPOINT_MISSING.
//
// v7: invalidates stale app.js for the share-modal inert fallback.
// Modern browsers (Chrome/Edge 102+, Safari 15.5+, FF 112+) ignore
// the change — they already honored the `inert` attribute. Older
// browsers + AT combos now get an explicit tabindex="-1" sweep on
// every focusable descendant when the modal is inactive, so a Tab
// walker can't land on the Close button while the modal is closed.
//
// v6: invalidates the stale app.js + styles.css cache after the
// deploy-flag audit landed:
//   - styles.css gained `[hidden] { display: none !important }` so
//     elements like the challenges nav link and notification toggle
//     actually disappear when their `hidden` attribute is set
//     (the .admin-link rule had display:flex which previously won).
//   - app.js loadMeta now propagates the dailyWord / leaderboard /
//     challenges / notifications flags from /api/meta to a global
//     deployCaps record, then hides the matching nav affordances
//     and short-circuits loadChallengeList() + refreshNotificationToggle()
//     when the flag is false. No more 404 noise on cold load.
//
// v5: invalidates the stale styles.css + app.js cache on existing
// installs. Two follow-ups landed in the same revision:
//   - .key-row gained width:100%. The row had only max-width set,
//     so it sized to min-content (~355 px on a 640 px keyboard)
//     and flex-grow had no free space to distribute — letters and
//     ENTER both pinned to min-width. Setting width:100% makes
//     flex actually work; .key.wide then expands to a Wordle-ish
//     proportion and "ENTER" gets visible breathing room.
//   - Player + challenge keyboards harden Backspace (⌫ wrapped in
//     <span aria-hidden>) and ENTER (aria-label = "Submit guess")
//     for stricter button-name auditors.
// SW's fetch handler is cache-first for non-API requests, so
// without the cache-name bump existing installs keep getting the
// old styles.css and the layout fix doesn't reach them.
//
// v4: invalidates the stale app.js cache on existing installs. The Vercel
// preview's app.js now reads dailyWordEnabled / leaderboardEnabled /
// challengesEnabled flags from /api/meta and hides the matching header
// nav links when each is false.
//
// v13: invalidates stale index.html + styles.css for the Space Grotesk
// + Bungee typography swap (#187, #188). New `<link rel="preload">` font
// entries in index.html and new `@font-face` + tile font-family in
// styles.css won't reach returning PWA users until the cache bumps.
//
// v12: invalidates stale app.js + styles.css for the skeleton play
// board (#191). Adds `mountSkeletonBoard` + a `tile-skeleton` keyframe;
// without the bump returning PWA users would see the pre-skeleton
// HTML/CSS that doesn't reference the new assets.
//
// v11: invalidates stale app.js + styles.css for the playful tile
// reactions (#182) + keyboard `:active` flash (#185) — adds five
// keyframes + JS triggers + a CSS scale on `.key:active`/.is-pressed.
// SW is cache-first for non-API, so without the bump returning users
// keep getting the pre-motion app.js/styles.css.
//
// v3: adds `push` + `notificationclick` listeners for the daily-puzzle
// Web Push notification flow (#92).
const CACHE_NAME = 'wordle-cache-v13';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/js/escape-html.js',
  '/js/i18n.js',
  '/js/random-name.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Self-hosted fonts (#187). Without these in the install precache,
  // the SW can miss them on first navigation (font preloads can fire
  // before SW activation), and an offline PWA visit falls back to the
  // system font stack. Copilot suppressed-comment on PR #195.
  '/fonts/space-grotesk-variable-latin.woff2',
  '/fonts/bungee-latin.woff2',
  '/admin/',
  '/admin/index.html',
  '/admin/admin.css',
  '/admin/app.js',
  '/dist/vendor/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => {
        return self.clients.claim();
      })
  );
});

// Push notifications. The server sends a JSON payload like
// `{title, body, url, tag}` (built by lib/notification-service.js); on
// an empty payload we fall back to a generic daily-puzzle copy so the
// listener never throws.
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_err) {
      payload = { title: 'Wordle', body: event.data.text() };
    }
  }
  const title = payload.title || "Today's Wordle is ready";
  const options = {
    body: payload.body || 'Open the app to play today\'s puzzle.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // `tag` collapses repeat notifications so a daily fire that lands
    // before a previous one was dismissed doesn't pile up.
    tag: typeof payload.tag === 'string' ? payload.tag : 'wordle-daily',
    data: {
      url: typeof payload.url === 'string' ? payload.url : '/'
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  // If a tab is already open at the target URL, focus it; otherwise
  // open a new window. clients.matchAll requires the includeUncontrolled
  // option so we see tabs from before this SW activated.
  // Compare PATH-ONLY: an URL with a query/hash like /play?day=123
  // would never match `clientUrl.pathname === '/play?day=123'` if we
  // compared the raw string, so we'd always open a new window.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          try {
            const clientUrl = new URL(client.url);
            const targetParsed = new URL(targetUrl, clientUrl.origin);
            if (clientUrl.pathname === targetParsed.pathname && 'focus' in client) {
              return client.focus();
            }
          } catch (_err) {
            // ignore parse errors and fall through to opening a new window
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return null;
      })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          return new Response(
            JSON.stringify({ error: 'Network unavailable' }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 503
            }
          );
        })
    );
  } else {
    event.respondWith(
      caches.match(event.request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }

          return fetch(event.request)
            .then((response) => {
              if (!response || response.status !== 200 || response.type !== 'basic') {
                return response;
              }

              const responseToCache = response.clone();
              caches.open(CACHE_NAME)
                .then((cache) => {
                  cache.put(event.request, responseToCache);
                });

              return response;
            })
            .catch(() => {
              if (event.request.mode === 'navigate') {
                if (url.pathname.startsWith('/admin')) {
                  return caches.match('/admin/index.html');
                }
                return caches.match('/index.html');
              }
              return new Response('Offline', { status: 503 });
            });
        })
    );
  }
});
