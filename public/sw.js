/* Spaces Board push service worker */
self.addEventListener('push', (event) => {
  let data = { title: 'Spaces Board', body: 'スペースの時間です', url: 'https://x.com' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title || 'Spaces Board', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/favicon.ico',
    data: { url: data.url || '/' },
    tag: data.tag || 'space-reminder',
    renotify: true
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
