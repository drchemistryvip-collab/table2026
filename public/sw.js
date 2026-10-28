const CACHE_NAME = 'jadwal-v12-offline-pwa';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of PRECACHE_URLS) {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch (err) {
          console.warn('Precache warning for:', url, err);
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  // Never cache backend API calls
  if (event.request.url.includes('/api/')) return;

  const isNavigation = event.request.mode === 'navigate';

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // If we are offline or have a cached static asset, use cached first or fetch network in background
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          if (cachedResponse) return cachedResponse;
          if (isNavigation) {
            const fallback =
              (await caches.match('./index.html')) ||
              (await caches.match('./')) ||
              (await caches.match('index.html')) ||
              (await caches.match('/'));
            if (fallback) return fallback;
          }
          return new Response('تۆ بێ ئینتەرنێتی، لێ زانیاریێن سەیڤکری د بەرنامەی دا بەردەستن.', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });

      return cachedResponse || fetchPromise;
    })
  );
});

// Handle background notification clicks on lockscreen or status bar
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});

// Message listener from web app for triggering SW notifications
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TRIGGER_ALARM_NOTIFICATION') {
    const { title, body } = event.data;
    self.registration.showNotification(title || 'ئاگاداریی جەتوەلا وانان', {
      body: body || 'دەرس دەست پێ دکەت',
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: [300, 100, 300, 100, 300, 100, 500],
      tag: 'lesson-alarm-lockscreen',
      renotify: true,
      requireInteraction: true,
      silent: false,
      data: { url: './' }
    });
  }
});