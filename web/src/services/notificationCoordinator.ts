const seenInThisTab = new Set<string>();
const channel = typeof window !== 'undefined' && 'BroadcastChannel' in window
  ? new BroadcastChannel('unichat-notifications')
  : null;
const STORAGE_PREFIX = 'unichat:notification-shown:';
const TTL_MS = 5 * 60 * 1000;

function storageKey(id: string) { return STORAGE_PREFIX + id; }

export function claimNotification(notificationId: string) {
  if (typeof window === 'undefined' || !notificationId) return true;
  if (seenInThisTab.has(notificationId)) return false;
  seenInThisTab.add(notificationId);
  try {
    const key = storageKey(notificationId);
    const previous = Number(window.localStorage.getItem(key) || 0);
    if (previous && Date.now() - previous < TTL_MS) return false;
    window.localStorage.setItem(key, String(Date.now()));
    channel?.postMessage({ type: 'notification-shown', notificationId });
    window.setTimeout(() => window.localStorage.removeItem(key), TTL_MS);
  } catch {
    // Private browsing/storage-disabled browsers still get an in-tab alert.
  }
  return true;
}

export function closeNotificationCoordinator() {
  channel?.close();
}
