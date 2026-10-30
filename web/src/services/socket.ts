import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || window.location.origin;

let refreshSession: (() => Promise<void>) | null = null;
export function setSocketSessionRefresher(callback: () => Promise<void>) { refreshSession = callback; }

let socket: Socket | null = null;

export function connectSocket(token: string | null): Socket {
  if (!socket) {
    // WebSocket first: it needs no sticky sessions behind a load balancer. Long-polling remains as a fallback.
    socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    // The server asks for a fresh token shortly before expiry; sending it over the open connection avoids a reconnect.
    socket.on('auth:expiring', () => { void refreshSession?.().catch(() => disconnectSocket()); });
    socket.on('auth:expired', () => { void refreshSession?.().catch(() => disconnectSocket()); });
    socket.on('connect_error', (error) => { if (/Unauthorized|expired/i.test(error.message)) void refreshSession?.().catch(() => disconnectSocket()); });
  }
  return socket;
}

export function getSocket() { return socket; }

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function updateSocketToken(token: string) {
  if (!socket) return;
  const activeSocket = socket;
  if ((activeSocket.auth as { token?: string }).token === token) return;
  activeSocket.auth = { token };
  if (!activeSocket.connected) { activeSocket.connect(); return; }
  // Re-authenticate in place. Only if the server rejects it do we fall back to reconnecting.
  activeSocket.timeout(8000).emit('auth:refresh', { token }, (error: Error | null, response?: { ok: boolean }) => {
    if (error || !response?.ok) { activeSocket.disconnect(); activeSocket.connect(); }
  });
}
