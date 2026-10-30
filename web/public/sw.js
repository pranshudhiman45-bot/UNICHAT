self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { /* Ignore malformed push data. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((client) => client.focused)) return;
    const candidate = new URL(payload.url || '/workspaces', self.location.origin);
    const allowed = candidate.origin === self.location.origin
      && (candidate.pathname.startsWith('/chat/') || candidate.pathname === '/admin' || candidate.pathname === '/workspaces');
    const url = allowed ? candidate.href : new URL('/workspaces', self.location.origin).href;
    await self.registration.showNotification(payload.title || 'Unichat', {
      body: payload.body || 'New activity',
      tag: payload.notificationId || undefined,
      data: { url },
      silent: Boolean(payload.silent),
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/workspaces', self.location.origin);
    const allowed = target.origin === self.location.origin
      && (target.pathname.startsWith('/chat/') || target.pathname === '/admin' || target.pathname === '/workspaces');
    if (!allowed) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === target.origin);
    if (existing) {
      await existing.navigate(target.href);
      await existing.focus();
    } else {
      await self.clients.openWindow(target.href);
    }
  })());
});
