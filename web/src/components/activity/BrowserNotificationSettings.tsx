import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { browserAlertsSupported, disableBrowserAlerts, enableBrowserAlerts, primeNotificationSound } from '../../services/browserNotifications';

export default function BrowserNotificationSettings() {
  const { user, updateNotificationSettings } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [delivery, setDelivery] = useState('');
  const enabled = user?.notificationSettings?.webPushEnabled === true;

  const toggle = async () => {
    setBusy(true); setError('');
    try {
      if (enabled) {
        await updateNotificationSettings({ webPushEnabled: false });
        await disableBrowserAlerts();
        setDelivery('Browser alerts are off.');
      } else {
        primeNotificationSound();
        const background = await enableBrowserAlerts();
        await updateNotificationSettings({ webPushEnabled: true });
        setDelivery(background ? 'Alerts can arrive after the tab closes.' : 'Alerts work while Unichat is open. The server needs Web Push keys for closed-tab delivery.');
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to update browser alerts.');
    } finally { setBusy(false); }
  };

  const update = async (setting: 'desktopNotifications' | 'mentions' | 'directMessages' | 'channelMessages' | 'threadReplies' | 'reactions' | 'calls' | 'securityAlerts' | 'sounds' | 'pushPreview', value: boolean) => {
    setError('');
    try { await updateNotificationSettings({ [setting]: value }); }
    catch { setError('Unable to update notification setting.'); }
  };

  return <div className="mb-4 border-b border-slate-200 pb-4 text-xs text-slate-600">
    <p className="mb-1 font-semibold text-slate-900">Browser alerts</p>
    <p className="mb-2">Get desktop notifications for activity when Unichat is in the background. Your browser may ask for permission.</p>
    <button type="button" onClick={() => void toggle()} disabled={busy || (!enabled && !browserAlertsSupported())}
      className="ui-primary-button px-3 py-1.5 font-semibold">
      {busy ? 'Updating…' : enabled ? 'Turn off browser alerts' : 'Turn on browser alerts'}
    </button>
    {!browserAlertsSupported() && <p className="mt-2">Requires HTTPS or localhost and browser notification support.</p>}
    {delivery && <p className="mt-2" role="status">{delivery}</p>}
    {error && <p className="mt-2 text-red-600" role="alert">{error}</p>}
    {enabled && <div className="mt-3 space-y-2">
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.desktopNotifications !== false} onChange={(event) => void update('desktopNotifications', event.target.checked)} /> Show desktop notifications</label>
      <p className="pt-1 font-semibold text-slate-900">Notify me about</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.mentions !== false} onChange={(event) => void update('mentions', event.target.checked)} /> Mentions</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.directMessages !== false} onChange={(event) => void update('directMessages', event.target.checked)} /> Direct messages</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.channelMessages === true} onChange={(event) => void update('channelMessages', event.target.checked)} /> All channel messages</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.threadReplies !== false} onChange={(event) => void update('threadReplies', event.target.checked)} /> Thread replies</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.reactions !== false} onChange={(event) => void update('reactions', event.target.checked)} /> Reactions</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.calls !== false} onChange={(event) => void update('calls', event.target.checked)} /> Calls</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.securityAlerts !== false} onChange={(event) => void update('securityAlerts', event.target.checked)} /> Security alerts</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.sounds !== false} onChange={(event) => void update('sounds', event.target.checked)} /> Allow notification sound</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={user?.notificationSettings?.pushPreview !== false} onChange={(event) => void update('pushPreview', event.target.checked)} /> Show message preview</label>
    </div>}
  </div>;
}
