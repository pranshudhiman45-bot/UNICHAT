# Unichat

Unichat is a Slack-style team chat app: workspaces, channels, direct messages, threads, reactions, search, attachments, notifications, and an admin console. It has one Node.js backend and a React web client that talk over a REST API and real-time Socket.IO events.

```text
Unichat/
├── backend/   Express + MongoDB + Socket.IO API (the single source of truth)
├── web/       React + TypeScript + Vite + Tailwind v4 client
├── shared/    Small code shared with the web client (workspace avatar logic)
├── tests/     Playwright browser tests
├── scripts/   Local setup / seed / dev launcher
└── docs/      Setup, production checklist, socket security, reference
```

## How the pieces connect

```text
  Web (React, :5173) ── HTTPS /api/*  (REST, JWT access token) ──►  Express API (:4000) ──► MongoDB  (all data)
                     ── WebSocket (token in `auth`)           ──►  Socket.IO server   ──► Redis    (optional: shared rate
                                                                                                    limits, multi-instance fan-out)
                                                    │
                                                    ├──► Cloudinary or local disk   (attachments, avatars)
                                                    ├──► SMTP or .local/mail        (OTP / recovery emails)
                                                    └──► Web Push                    (notifications when the tab is closed)
```

The rule that ties everything together: **REST writes, sockets announce.** A client changes data with a REST call (`POST /api/messages`). The server saves it, then emits a socket event to the people who are allowed to see it. Other clients update their screens from that event. On reconnect, clients call the `/sync` endpoints to catch up on anything they missed.

### Message life cycle (example)

1. The client sends `POST /api/messages` with `workspaceId`, `channelId` (or `dmId`), `content`, and a `clientMessageId`.
2. The backend checks the token, rate limit, and that you are a member of that channel/DM. A repeated `clientMessageId` returns the original message, so a retry never duplicates it.
3. The message is saved, mentions are parsed, and `Notification` records are created.
4. Socket.IO emits `message:new` to the channel/DM room (or `thread:new` for a reply), and `notification:new` to mentioned users. Clients that are offline get a Web push instead.
5. Each client appends the message. When the user opens the conversation, the client calls `PUT /channels/:id/mark-read` (or the DM equivalent); other devices of that user get `channel:read` / `dm:read` so unread badges stay in sync.

## Running it locally

Requirements: Node 22.12+ and a MongoDB on `127.0.0.1:27017`. Redis, Cloudinary, SMTP, and Google credentials are **optional** locally.

```sh
npm ci
npm --prefix backend ci
npm --prefix web ci

npm run setup:local   # generates secrets + .env.test.local files (local DB, file email, local uploads)
npm run seed:local    # fictional demo data in the dedicated unichat_local_test database
npm run dev           # backend on :4000 and web on :5173
```

Open **http://localhost:5173**. Demo logins are in `.local/test-accounts.json`. Emails (verification codes, password resets) are written to `.local/mail/` instead of being sent.


Running pieces separately (uses the regular `.env` files): `npm --prefix backend run dev` and `npm --prefix web run dev`. Run only one setup at a time because both use port 4000.

### Configuration at a glance

| File | Key settings |
|---|---|
| `backend/.env` | `PORT`, `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CLIENT_URL`, `ALLOWED_ORIGINS` (CORS), `FILE_STORAGE` (`cloudinary` or `local`), `EMAIL_TRANSPORT` (`smtp` or `file`), `REDIS_URL` (optional), `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` |
| `web/.env` | `VITE_API_URL` (`http://localhost:4000/api`), `VITE_SOCKET_URL` (`http://localhost:4000`) |

Full variable list with comments: [backend/.env.example](backend/.env.example). The web origin must be listed in `ALLOWED_ORIGINS` or the browser blocks API calls.

## What works and where it lives

| Feature | Backend | Web |
|---|---|---|
| Register / login / refresh / logout, email OTP, Google sign-in | `routes/auth.js`, `routes/identity.js`, `services/authSessions.js`, `services/emailVerification.js` | `hooks/useAuth.tsx`, `pages/Login.tsx`, `pages/Register.tsx` |
| Password recovery (email OTP, or admin-approved mode) | `routes/passwordResets.js`, `services/passwordRecovery.js` | `pages/ForgotPassword.tsx`, `pages/RecoveryApproval.tsx` |
| Workspaces, invite codes, join requests, roles, ownership transfer | `routes/workspaces.js`, `services/workspaceJoining.js`, `services/workspaceMembership.js` | `pages/Workspaces.tsx`, `components/workspaces/*` |
| Channels (public/private), members, archive, pins | `routes/channels.js` | `components/channels/*`, `components/pinned/*` |
| Messages: send, edit, delete, reactions, mentions, rich text | `routes/messages.js`, `utils/richContent.js` | `components/messages/*`, `components/emoji/*`, `components/mentions/*` |
| Threads | `routes/messages.js` (`/thread/:id`) | `components/threads/*` |
| Direct and group DMs | `routes/dms.js` | `components/conversations/*` |
| Saved messages (one list; "Starred" is a legacy alias) | `routes/saved.js` | `components/saved/*` |
| Search | `routes/search.js` | `components/search/*` |
| Attachments (image, video, documents) | `routes/files.js`, `services/fileStorage.js`, `services/attachmentAccess.js` | `MessageComposer`, `services/attachmentUrls.ts` |
| Activity / notifications, mute, Do Not Disturb | `routes/notifications.js`, `services/notifications.js` | `components/activity/*` |
| Browser push | `services/pushNotifications.js`, `services/webPush.js` | `services/browserNotifications.ts` |
| Presence and typing | `socket/socketHandler.js`, `services/presence.js` | `pages/Chat.tsx` |
| Admin console, audit log, recovery settings | `routes/admin.js` | `pages/Admin.tsx` |

### Data model (`backend/src/models`)

`User`, `Workspace` (members + roles + join requests), `Channel`, `DirectMessage` (1:1 and group), `Message` (channel, DM, or thread reply), `MessageSeen`, `Notification`, `SavedMessage`, `StoredAttachment`, `PushDevice`, `WebPushSubscription`, `EmailChallenge`, `PasswordResetRequest`, `RecoverySettings`, `AuditLog`, `JobLock`.

### Socket events

Client to server: `workspace:join`, `channel:join`, `dm:join`, `thread:join` (and the matching `:leave`), `typing:start`, `typing:stop`, `presence:update`, `message:read`, `auth:refresh`. The server only lets you join rooms you are a member of, and removes you from them immediately when you leave or are removed.

Server to client: `message:new`, `message:updated`, `message:deleted`, `message:reaction`, `message:pinned`, `thread:new`, `channel:created` / `updated` / `archived` / `invited` / `removed`, `dm:created` / `updated` / `removed`, `workspace:*` membership events, `typing:update`, `user:presence_update`, `user:profile_updated`, `notification:new` / `read` / `read_all`, `saved:changed`, `channel:read`, `dm:read`. Details and the per-event audit: [docs/SOCKET_SECURITY.md](docs/SOCKET_SECURITY.md).

### Security model in one paragraph

Web refresh tokens live in an HttpOnly cookie, access tokens in memory. Every route checks workspace/channel/DM membership on the server, never in the client. Passwords are bcrypt-hashed, auth routes are rate-limited, uploads are served through short-lived authorized links, and the admin account exists only through server-side `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH`. See [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Testing

```sh
npm run verify          # lint + web build + unit tests + full backend suite
npm run test:backend    # 22 integration files; needs local mongod and redis-server
npm run test:e2e        # Playwright browser tests (restart the backend first; login limiter is 10 per 15 min)
```

`npm run lint` is only a syntax check (no ESLint is configured). Each backend test creates and drops its own throwaway database, so your data is never touched. `npm run seed` in `backend/` **wipes** the configured database and requires `--confirm-destroy-all-data`.

## Known limits

- Cloudinary, SMTP, Google sign-in, and real push delivery are only tested with local or mocked services here. Verify them with real credentials before relying on them.
- Only the account matching `ADMIN_EMAIL` can sign in as super admin.

## More documentation

- [docs/SETUP.md](docs/SETUP.md): local setup, Google sign-in, Gmail OTP, deployment
- [docs/PRODUCTION.md](docs/PRODUCTION.md): deployment checklist and environment reference
- [docs/SOCKET_SECURITY.md](docs/SOCKET_SECURITY.md): per-event socket authorization
- [docs/REFERENCE.md](docs/REFERENCE.md): admin and recovery details, API route table, notification setup
