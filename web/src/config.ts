// Public client configuration, read from Vite build-time variables. Never put secrets here: every VITE_* value is
// embedded in the JavaScript bundle that browsers download.
const trimSlash = (value: string) => value.trim().replace(/\/+$/, '');

// REST base URL, e.g. https://unichat-api.onrender.com/api (deployed) or http://localhost:4000/api (local).
// Falls back to same-origin /api only for setups that proxy the API behind the web origin.
export const API_URL = trimSlash(import.meta.env.VITE_API_URL || '/api');

// Without a timeout, a backend that accepts the connection but never answers (e.g. a host that is still starting)
// would leave requests, and the startup session check, pending forever. File uploads opt out per request.
export const REQUEST_TIMEOUT_MS = 30_000;
// The startup session check gives up sooner so the sign-in page appears; it then keeps retrying in the background.
export const SESSION_CHECK_TIMEOUT_MS = 20_000;

// Must match the API rule (backend/src/services/emailVerification.js).
export const MIN_PASSWORD_LENGTH = 8;

// Socket.IO server origin. Defaults to the origin of an absolute API_URL, so deployments only need VITE_API_URL.
export const SOCKET_URL = trimSlash(
  import.meta.env.VITE_SOCKET_URL || (/^https?:\/\//i.test(API_URL) ? new URL(API_URL).origin : window.location.origin),
);
