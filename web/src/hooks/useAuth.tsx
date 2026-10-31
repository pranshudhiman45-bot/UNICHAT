import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import axios from 'axios';
import { disconnectSocket, updateSocketToken, setSocketSessionRefresher } from '../services/socket';
import type { User as PublicUser } from '../types';
import { API_URL, REQUEST_TIMEOUT_MS, SESSION_CHECK_TIMEOUT_MS } from '../config';

interface User extends PublicUser {
  email: string;
  notificationSettings?: NotificationSettings;
}

export interface ProfileChanges {
  displayName: string;
  title: string;
  bio: string;
  statusMessage: string;
  timezone: string;
}

export interface NotificationSettings {
  mentions?: boolean;
  directMessages?: boolean;
  channelMessages?: boolean;
  threadReplies?: boolean;
  reactions?: boolean;
  calls?: boolean;
  securityAlerts?: boolean;
  desktopNotifications?: boolean;
  webPushEnabled?: boolean;
  sounds?: boolean;
  pushPreview?: boolean;
}

export interface AuthConfig { googleEnabled: boolean; googleClientId: string; emailVerificationRequired: boolean; allowedRegistrationDomain: string; passwordRecoveryMode: 'email' | 'admin'; workspaceCreation: 'admin' | 'members'; }

interface AuthContextType {
  config: AuthConfig | null;
  googleLogin: (credential: string, emailVerificationToken?: string) => Promise<User>;
  user: User | null;
  login: (email: string, password: string) => Promise<User>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  updateNotificationSettings: (changes: NotificationSettings) => Promise<void>;
  updateProfile: (changes: ProfileChanges) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  removeAvatar: () => Promise<void>;
  isLoading: boolean;
  /** True while the startup session check cannot reach the API; it keeps retrying in the background. */
  serverUnreachable: boolean;
}

interface RegisterData {
  emailVerificationToken?: string;
  username: string;
  email: string;
  password: string;
  displayName: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const COOKIE_AUTH_HEADER = { 'X-Client-Auth': 'cookie' };
const api = axios.create({ baseURL: API_URL, withCredentials: true, headers: COOKIE_AUTH_HEADER, timeout: REQUEST_TIMEOUT_MS });
let sessionEpoch = 0;
let activeAccessToken: string | null = null;
let onAuthenticationExpired: (() => void) | null = null;
let refreshPromise: Promise<string> | null = null;

// No HTTP response at all: offline, DNS/TLS failure, CORS rejection, or a timeout. Unlike a 401 this says nothing about
// the session, so it must not sign the user out.
function isUnreachable(error: unknown) {
  return axios.isAxiosError(error) && !error.response && error.code !== 'ERR_CANCELED';
}

async function unsubscribeBrowser(notifyServer = true) {
  try {
    const registration = await navigator.serviceWorker?.getRegistration('/');
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) {
      if (notifyServer) await api.delete('/users/web-push/subscriptions', { data: { endpoint: subscription.endpoint } }).catch(() => undefined);
      await subscription.unsubscribe();
    }
  } catch { /* Session cleanup remains best-effort if offline. */ }
}

function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    const epoch = sessionEpoch;
    const refresh = () => axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true, headers: COOKIE_AUTH_HEADER, timeout: SESSION_CHECK_TIMEOUT_MS });
    const request = navigator.locks ? navigator.locks.request('unichat-session-refresh', refresh) : refresh();
    refreshPromise = request
      .then((response) => {
        if (epoch !== sessionEpoch) throw new Error('Session changed');
        activeAccessToken = response.data.accessToken;
        updateSocketToken(response.data.accessToken);
        return response.data.accessToken as string;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

setSocketSessionRefresher(async () => {
  try { await refreshAccessToken(); }
  catch (error) { if (!isUnreachable(error)) { activeAccessToken = null; onAuthenticationExpired?.(); } throw error; }
});

api.interceptors.request.use((config) => {
  if (activeAccessToken) {
    config.headers.Authorization = `Bearer ${activeAccessToken}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config as (typeof error.config & { _retry?: boolean }) | undefined;

    if (error.response?.status !== 401 || !original || original._retry || (original.url?.startsWith('/auth/') && original.url !== '/auth/me' && original.url !== '/auth/logout')) {
      return Promise.reject(error);
    }

    original._retry = true;
    try {
      const accessToken = await refreshAccessToken();
      original.headers = original.headers || {};
      original.headers.Authorization = `Bearer ${accessToken}`;
      return api(original);
    } catch (refreshError) {
      // A network failure during refresh keeps the session; the request fails and can be retried.
      if (isUnreachable(refreshError)) return Promise.reject(refreshError);
      activeAccessToken = null;
      disconnectSocket();
      onAuthenticationExpired?.();
      void unsubscribeBrowser(false);
      return Promise.reject(refreshError);
    }
  },
);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => { void api.get('/auth/config').then((response) => setConfig(response.data)).catch(() => undefined); }, []);
  const [isLoading, setIsLoading] = useState(true);
  const [serverUnreachable, setServerUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    onAuthenticationExpired = () => { if (!cancelled) setUser(null); };
    // Restores the session from the refresh cookie. Loading always ends: on success, on a definitive "no session", or
    // when the API cannot be reached. In the last case the sign-in page renders and the check retries with backoff, so
    // a still-valid session is restored automatically once the API answers (e.g. after a cold start).
    const restoreSession = () => {
      const epoch = sessionEpoch;
      refreshAccessToken()
        .then(() => api.get('/auth/me', { timeout: SESSION_CHECK_TIMEOUT_MS }))
        .then((res) => { if (!cancelled && epoch === sessionEpoch) { setUser(res.data.user); setServerUnreachable(false); } })
        .catch((error) => {
          if (cancelled || epoch !== sessionEpoch) return;
          if (isUnreachable(error)) {
            setServerUnreachable(true);
            attempt += 1;
            retryTimer = window.setTimeout(restoreSession, Math.min(30_000, 5_000 * attempt));
          } else {
            activeAccessToken = null;
            setServerUnreachable(false);
          }
        })
        .finally(() => { if (!cancelled) setIsLoading(false); });
    };
    restoreSession();
    return () => { cancelled = true; window.clearTimeout(retryTimer); if (onAuthenticationExpired) onAuthenticationExpired = null; };
  }, []);

  // A successful sign-in proves the API is reachable again.
  useEffect(() => { if (user) setServerUnreachable(false); }, [user]);

  const login = async (email: string, password: string) => {
    sessionEpoch++;
    const res = await api.post('/auth/login', { email, password });
    activeAccessToken = res.data.accessToken;
    updateSocketToken(activeAccessToken || '');
    setUser(res.data.user);
    return res.data.user as User;
  };

  const googleLogin = async (credential: string, emailVerificationToken?: string) => {
    sessionEpoch++;
    const res = await api.post('/auth/google', { credential, emailVerificationToken });
    activeAccessToken = res.data.accessToken;
    updateSocketToken(activeAccessToken || '');
    setUser(res.data.user);
    return res.data.user as User;
  };

  const register = async (data: RegisterData) => {
    sessionEpoch++;
    const res = await api.post('/auth/register', data);
    activeAccessToken = res.data.accessToken;
    updateSocketToken(activeAccessToken || '');
    setUser(res.data.user);
  };

  const logout = async () => {
    sessionEpoch++;
    await unsubscribeBrowser();
    try {
      await api.post('/auth/logout', {});
    } catch {
      // Local logout should still complete if the server is unavailable.
    }
    activeAccessToken = null;
    disconnectSocket();
    setUser(null);
  };

  const updateNotificationSettings = async (changes: NotificationSettings) => {
    const response = await api.put('/users/notification-settings', changes);
    setUser((current) => current ? { ...current, notificationSettings: response.data.notificationSettings } : current);
  };

  const updateProfile = async (changes: ProfileChanges) => {
    const response = await api.put('/users/profile', changes);
    setUser(response.data.user);
  };

  const uploadAvatar = async (file: File) => {
    const form = new FormData();
    form.append('avatar', file);
    const response = await api.post('/users/avatar', form, { timeout: 0 }); // file transfer: no fixed limit
    setUser(response.data.user);
  };

  const removeAvatar = async () => {
    const response = await api.delete('/users/avatar');
    setUser(response.data.user);
  };

  return (
    <AuthContext.Provider value={{ user, config, googleLogin, login, register, logout, updateNotificationSettings, updateProfile, uploadAvatar, removeAvatar, isLoading, serverUnreachable }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

export function getAccessToken() {
  return activeAccessToken;
}

export { api };
