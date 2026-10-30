import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import axios from 'axios';
import { disconnectSocket, updateSocketToken, setSocketSessionRefresher } from '../services/socket';
import type { User as PublicUser } from '../types';

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
}

interface RegisterData {
  emailVerificationToken?: string;
  username: string;
  email: string;
  password: string;
  displayName: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_URL = import.meta.env.VITE_API_URL || '/api';

const COOKIE_AUTH_HEADER = { 'X-Client-Auth': 'cookie' };
const api = axios.create({ baseURL: API_URL, withCredentials: true, headers: COOKIE_AUTH_HEADER });
let sessionEpoch = 0;
let activeAccessToken: string | null = null;
let onAuthenticationExpired: (() => void) | null = null;
let refreshPromise: Promise<string> | null = null;

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
    const refresh = () => axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true, headers: COOKIE_AUTH_HEADER });
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
  catch (error) { activeAccessToken = null; onAuthenticationExpired?.(); throw error; }
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

  useEffect(() => {
    let cancelled = false;
    onAuthenticationExpired = () => { if (!cancelled) setUser(null); };
    refreshAccessToken()
      .then(() => api.get('/auth/me'))
      .then((res) => { if (!cancelled) setUser(res.data.user); })
      .catch(() => { activeAccessToken = null; })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; if (onAuthenticationExpired) onAuthenticationExpired = null; };
  }, []);

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
    const response = await api.post('/users/avatar', form);
    setUser(response.data.user);
  };

  const removeAvatar = async () => {
    const response = await api.delete('/users/avatar');
    setUser(response.data.user);
  };

  return (
    <AuthContext.Provider value={{ user, config, googleLogin, login, register, logout, updateNotificationSettings, updateProfile, uploadAvatar, removeAvatar, isLoading }}>
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
