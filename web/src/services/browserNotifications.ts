import { api, type NotificationSettings } from '../hooks/useAuth';
import type { NotificationItem } from '../types';
import { idOf } from '../types';
import { claimNotification } from './notificationCoordinator';

let pushSubscriptionActive = false;
let notificationAudio: AudioContext | null = null;
const pendingBatches = new Map<string, { items: NotificationItem[]; timer: number }>();

export function primeNotificationSound() {
  try {
    notificationAudio ||= new AudioContext();
    void notificationAudio.resume();
  } catch { /* Audio is optional when the browser does not allow it. */ }
}

function playNotificationSound() {
  try {
    if (!notificationAudio || notificationAudio.state !== 'running') return;
    const oscillator = notificationAudio.createOscillator();
    const gain = notificationAudio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(700, notificationAudio.currentTime);
    oscillator.frequency.setValueAtTime(900, notificationAudio.currentTime + 0.08);
    gain.gain.setValueAtTime(0.045, notificationAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, notificationAudio.currentTime + 0.17);
    oscillator.connect(gain).connect(notificationAudio.destination);
    oscillator.start();
    oscillator.stop(notificationAudio.currentTime + 0.18);
  } catch { /* Never let a sound failure affect message delivery. */ }
}

export function browserAlertsSupported() {
  return typeof window !== 'undefined' && window.isSecureContext
    && 'Notification' in window && 'serviceWorker' in navigator;
}

function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
  const result = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) result[index] = raw.charCodeAt(index);
  return result;
}

export async function enableBrowserAlerts() {
  if (!browserAlertsSupported()) throw new Error('Browser alerts require HTTPS or localhost and a supported browser.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Browser notification permission was not granted. Check the site permission in your browser.');
  const registration = await navigator.serviceWorker.register('/sw.js');
  const config = await api.get<{ publicKey: string | null }>('/users/web-push/config');
  if (config.data.publicKey && 'PushManager' in window) {
    try {
      const subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(config.data.publicKey) });
      const value = subscription.toJSON();
      await api.post('/users/web-push/subscriptions', { endpoint: subscription.endpoint, keys: value.keys, userAgent: navigator.userAgent });
      pushSubscriptionActive = true;
    } catch {
      pushSubscriptionActive = false; // Socket alerts remain available while the tab is open.
    }
  } else {
    pushSubscriptionActive = false;
  }
  return pushSubscriptionActive;
}

export async function refreshBrowserPush() {
  if (!browserAlertsSupported() || Notification.permission !== 'granted') return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  const config = await api.get<{ publicKey: string | null }>('/users/web-push/config');
  if (!config.data.publicKey) return;
  await api.post('/users/web-push/subscriptions', { endpoint: subscription.endpoint, keys: subscription.toJSON().keys, userAgent: navigator.userAgent });
  pushSubscriptionActive = true;
}

export async function disableBrowserAlerts() {
  const registration = await navigator.serviceWorker?.getRegistration('/');
  const subscription = await registration?.pushManager?.getSubscription();
  if (subscription) {
    await api.delete('/users/web-push/subscriptions', { data: { endpoint: subscription.endpoint } });
    await subscription.unsubscribe();
  }
  pushSubscriptionActive = false;
}

export function notificationUrl(notification: NotificationItem) {
  if (['password_recovery', 'security_alert', 'admin_alert'].includes(notification.type)) return '/admin?tab=password-resets';
  const workspaceId = idOf(notification.workspace);
  if (notification.type === 'workspace_join_request') return `/workspaces?review=${encodeURIComponent(workspaceId || '')}`;
  if (notification.type === 'workspace_join_approved') return `/chat/${encodeURIComponent(workspaceId || '')}`;
  const query = new URLSearchParams();
  if (notification.channel?._id) query.set('channelId', notification.channel._id);
  if (notification.dm?._id) query.set('dmId', notification.dm._id);
  const threadParentId = idOf(notification.threadParent);
  if (threadParentId) query.set('threadParentId', threadParentId);
  if (notification.message?._id) query.set('messageId', notification.message._id);
  return `/chat/${encodeURIComponent(workspaceId || '')}?${query.toString()}`;
}

function cleanPreview(value: unknown) {
  return String(value || '').replace(/<@[^>]+>/g, '@someone').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function displayBrowserAlert(notification: NotificationItem, settings: NotificationSettings, batchCount = 1) {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const body = settings.pushPreview === false ? 'Open Unichat to view this update'
    : batchCount > 1
      ? `${batchCount} new messages in ${notification.channel?.name ? `#${notification.channel.name}` : 'Unichat'}`
      : cleanPreview(notification.metadata?.preview || notification.message?.content || notification.content) || 'New activity';
  if (settings.sounds !== false && notification.metadata?.sound !== false) playNotificationSound();
  await registration.showNotification(batchCount > 1 ? 'Unichat' : (notification.actor?.displayName || 'Unichat'), {
    body,
    tag: batchCount > 1 ? `context:${notification.channel?._id || notification.dm?._id || 'workspace'}` : notification._id,
    data: { url: notificationUrl(notification) },
    silent: settings.sounds === false || notification.metadata?.sound === false,
  });
}

function queueChannelAlert(notification: NotificationItem, settings: NotificationSettings) {
  const key = notification.channel?._id || notification.dm?._id || 'workspace';
  const existing = pendingBatches.get(key);
  if (existing) {
    existing.items.push(notification);
    return;
  }
  const batch = { items: [notification], timer: 0 };
  batch.timer = window.setTimeout(() => {
    pendingBatches.delete(key);
    const latest = batch.items[batch.items.length - 1];
    void displayBrowserAlert(latest, settings, batch.items.length).catch(() => undefined);
  }, 1500);
  pendingBatches.set(key, batch);
}

export async function showLiveBrowserAlert(notification: NotificationItem, settings?: NotificationSettings, current?: { workspaceId?: string; type: string; id?: string; threadId?: string }) {
  if (notification.isRead || notification.readAt || notification.metadata?.deliverySuppressed) return;
  if (!settings?.webPushEnabled || settings.desktopNotifications === false || !browserAlertsSupported() || Notification.permission !== 'granted') return;
  const contextId = notification.channel?._id || notification.dm?._id;
  const contextType = notification.channel ? 'channel' : 'dm';
  if (!document.hidden && idOf(notification.workspace) === current?.workspaceId
    && current?.type === contextType && current.id === contextId
    && (!notification.threadParent || current.threadId === idOf(notification.threadParent))) return;
  const visible = !document.hidden;
  if (!visible && pushSubscriptionActive) return; // The service worker handles background Web Push.
  if (!claimNotification(notification._id)) return;
  if (notification.type === 'channel_message') {
    queueChannelAlert(notification, settings);
    return;
  }
  await displayBrowserAlert(notification, settings);
}
