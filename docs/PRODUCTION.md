# Production guide

This is the operational companion to [SETUP.md](SETUP.md). Security design notes for realtime are in
[SOCKET_SECURITY.md](SOCKET_SECURITY.md).

## 1. Architecture in one paragraph

Stateless Node/Express API + Socket.IO (any number of instances) → MongoDB (system of record for messages, membership,
sessions) → optional Redis (shared rate-limit counters + Socket.IO fan-out across instances) → Cloudinary
(authenticated, signed-URL file storage) → SMTP (verification/recovery codes). Client: React web.
**The database, not socket delivery, is the source of truth**: after any gap clients call the `…/sync` endpoints.

## 2. Deployment checklist

Do these in order. Items marked **(gate)** must be true before real users are invited.

**Infrastructure**
- [ ] **(gate)** HTTPS everywhere; reverse proxy forwards `X-Forwarded-For`, and `TRUST_PROXY_HOPS` equals the exact number of proxies in front of the API (otherwise every client shares one IP and per-IP limits/audit logs collapse).
- [ ] **(gate)** MongoDB with authentication, TLS, daily backups **and a tested restore**.
- [ ] **(gate)** If you run more than one API instance: `REDIS_URL` set (TLS, password). Without Redis the instances do not share rate limits or realtime events.
- [ ] Load balancer: health check `GET /health/live` (liveness) and `GET /health` (readiness; returns **200 even when Redis is down**, with `status: "degraded"`; 503 only if MongoDB is down). WebSocket upgrade enabled. Sticky sessions if long-polling is allowed.
- [ ] Process manager restarts on exit and sends `SIGTERM` for graceful shutdown (10 s deadline).

**Configuration** (reference in §3)
- [ ] **(gate)** `NODE_ENV=production`, distinct `JWT_SECRET` / `JWT_REFRESH_SECRET` (≥32 random chars each).
- [ ] **(gate)** `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` (bcrypt cost ≥12, generated with `npm run hash:admin-password`).
- [ ] **(gate)** `PUBLIC_API_URL` (https), `ALLOWED_ORIGINS` (https, exact list), `CLIENT_URL`.
- [ ] **(gate)** Cloudinary credentials (`FILE_STORAGE=cloudinary`); SMTP credentials and `SMTP_FROM`. The server refuses to start in production with local file storage or file-based email.
- [ ] `EXPO_ACCESS_TOKEN` / `WEB_PUSH_*` if push is wanted.
- [ ] Decide `PASSWORD_RECOVERY_MODE` (see §5).

**Database**
- [ ] `npm --prefix backend run db:indexes` after every release that adds indexes (idempotent, non-destructive).
- [ ] No manual migration is required for this release; see §4.

**Verification before go-live**
- [ ] **(gate)** `npm run verify` is green on the release commit.
- [ ] **(gate)** Manual QA on real services (§6): Cloudinary upload/download, SMTP delivery, and browser push.
- [ ] Start the API once in staging with the production environment and read the startup warnings: they list weakened protections (no Redis, `TRUST_PROXY_HOPS=0`, …).
- [ ] **Never run `npm run seed` against anything but a disposable local database** (it is hard-blocked in production, and refuses non-local URIs without `SEED_ALLOW_REMOTE=true`).

## 3. Environment reference

Required in production: `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PUBLIC_API_URL`, `ALLOWED_ORIGINS`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD_HASH`, `SMTP_HOST`, `SMTP_FROM`, Cloudinary credentials.

| Variable | Default | Purpose |
|---|---|---|
| `TRUST_PROXY_HOPS` | `0` | Exact number of trusted reverse proxies. **Set correctly in production.** |
| `REDIS_URL` | – | Shared limits + multi-instance realtime. |
| `REDIS_STARTUP_WAIT_MS` | `10000` | How long startup waits for Redis. |
| `REDIS_OPTIONAL` | `false` | In production, start (degraded, single-instance) even if Redis is unreachable. Otherwise the API refuses to start when `REDIS_URL` is set but unreachable. |
| `REFRESH_REUSE_WINDOW_SECONDS` | `30` | Previous refresh token still accepted for this long (a lost response does not log the user out). `0` = strict single-use. |
| `PRESENCE_GRACE_MS` | `8000` | Delay before a user with no connections shows offline. |
| `API_RATE_LIMIT_USER` | `1500` | Requests / 15 min for signed-in users (per user). |
| `API_RATE_LIMIT_IP` | `300` | Requests / 15 min for anonymous traffic (per IP; IPv6 per /64). |
| `MESSAGE_SEND_LIMIT_PER_MINUTE` | `60` | Messages per user per minute. |
| `UPLOAD_LIMIT_PER_10_MIN` | `60` | Upload requests per user. |
| `MAX_FILE_SIZE_MB` / `MAX_ATTACHMENTS` | `25` / `10` | Per-file size and files per message. |
| `MAX_CONCURRENT_UPLOADS` | `8` | Simultaneous uploads per instance (`429` + `Retry-After` beyond). Uploads spool to the OS temp dir, not RAM. |
| `SOCKET_EVENT_BURST` / `SOCKET_EVENT_RATE` | `60` / `20` | Per-connection event budget. |
| `CLEANUP_INTERVAL_MINUTES` | `15` | Abandoned-upload sweeper (`0` disables). Uses a database lease so only one instance works at a time. |
| `NOTIFICATION_RETENTION_DAYS` | `90` | TTL for notifications (`0` keeps all). Applies when the index is created. |
| `MAX_THREAD_REPLIES_PER_RESPONSE` | `1000` | Thread responses are bounded and flag `truncated`. |
| `SEED_ALLOW_REMOTE` | – | Only for disposable non-production databases. |

## 4. What changed in this release (migrations and compatibility)

* **No data migration is required.** `StarredMessage` rows are copied into `SavedMessage` automatically and idempotently at startup (`utils/migrations.js`). The old `/api/starred` endpoint remains as a deprecated alias over the same data (`Deprecation` header); remove it after all mobile builds have updated.
* **New collections:** `pushdevices`, `joblocks`. **Removed field:** `Message.readBy` (was never written; existing values are ignored — optionally `db.messages.updateMany({}, {$unset:{readBy:""}})`).
* **New indexes** (created automatically, or via `npm run db:indexes`): message paging indexes on `(channel|dm, thread.parentMessage, createdAt, _id)` and `(channel|dm, updatedAt)`, a per-sender unique idempotency index, attachment cleanup indexes, and TTL indexes on notifications (90 d) and fully-deleted attachment records (30 d).
* **Push tokens:** `User.pushTokens` is no longer read. Devices re-register themselves on app start (opt-in setting), moving to `PushDevice`.
* **Behaviour changes clients must know about**
  * Fetching message history **no longer marks a conversation read**. Clients call `PUT /channels/:id/mark-read` / `PUT /dms/:id/mark-read` (the web client does). Third-party clients must too.
  * Message sends accept an optional `clientMessageId` (8–64 URL-safe chars); retries with the same id return the original message (`200`, `duplicate: true`).
  * Socket `message:*` events no longer contain attachment URLs; use `POST /api/files/urls`.
  * `typing:update` carries `{ userId, action: 'start' | 'stop' }`; the server no longer sends the full typist list.
  * History endpoints return `nextCursor` and `serverTime` and accept `before` + `beforeId`.
  * Password-recovery "direct approval" was removed (see §5).
  * Profiles (`GET /users/profile/:id`) are visible only to people who share a workspace.

## 5. Account recovery

Two modes (`PASSWORD_RECOVERY_MODE`):

* **`email` (default):** a one-time code is emailed to the account's own address. Only the mailbox owner can reset.
* **`admin`:** a request goes to the administrator. Approval **never gives the requester a credential**. Either the code is emailed to the account holder (default), or the administrator reveals it and delivers it after verifying identity out of band. Five wrong codes lock the request; codes expire; reset revokes every session and every push device.

Product decision still open: the recovery settings accept several "approvers", but only the account configured as `ADMIN_EMAIL` can authenticate as a super admin. The settings API now rejects approvers who could not actually sign in. Supporting several named administrators needs per-admin credentials (e.g. `ADMIN_ACCOUNTS`) — not implemented.

## 6. Manual QA that automated tests cannot cover

1. **Cloudinary:** upload an image, a video and a PDF; open each in another account; confirm the raw Cloudinary URL is not usable without the signature; delete the message and confirm the link dies. (Automated tests use local file storage.)
2. **SMTP:** verification and recovery emails arrive and the codes work.
4. **Web push** on HTTPS with VAPID keys.
5. **Load:** a soak test with your expected concurrent users (the included tests prove behaviour and bounded query/memory cost, not capacity).

## 7. Operating it

* **Redis outage:** the API stays up. Rate limits fall back to per-instance counters with the same limits (they are never switched off); same-instance realtime continues; cross-instance fan-out pauses and resumes automatically. `/health` shows `degraded`; logs show `Redis connection lost` / `Redis recovered after Ns`.
* **Reconnect storms:** clients catch up via `GET /api/messages/channel/:id/sync?since=` and `GET /api/dms/:id/sync?since=` (max 200 changes, otherwise `truncated: true` and they reload).
* **Cleanup:** `/health` → `cleanup` reports runs and counts. Files that cannot be removed from Cloudinary are retried with backoff 8 times and then logged `manual cleanup needed`.
* **Logging:** error logs never contain message text, tokens, passwords or attachment URLs; Mongoose validation errors are reduced to the field names.
* **Audit log:** `AuditLog` has no retention (kept for compliance). Add a TTL index if policy allows.

## 8. Commands

```sh
npm run test:backend      # 20 backend integration files (own throwaway databases; needs local mongod + redis-server)
npm --prefix backend run test:legacy   # pre-existing auth/admin/regression/redis/startup suites
npm run test:e2e          # Playwright; start the stack first (see below)
npm run lint              # backend syntax gate (no ESLint is configured)
```

Browser tests: `npm run setup:local && npm run seed:local`, then start `npm run dev` **with a fresh backend** (the login limiter allows 10 attempts / 15 min per IP, and the specs sign in a few times), then `npm run test:e2e`.
