# Release verification

Status of this document: written at the end of the hardening pass. It separates **what automated tests proved** from
**what only real credentials, a real phone, or real infrastructure can prove**. Nothing here treats a mock or a local
stand-in as a production service.

Tools added for this phase (no product behaviour changed):

| Command | Purpose |
|---|---|
| `npm --prefix backend run check:prod-config` | Prints REQUIRED / OPTIONAL / UNSAFE / MISSING / CORRECT per setting. **Never prints a value.** `ENV_FILE=/path/prod.env` or `--env-file`. Exit 1 if anything blocks. |
| `npm --prefix backend run test:prod-config` | Boots the **real server** in production mode with dangerous settings and proves it refuses them. |
| `node backend/scripts/security-probe.js` | Read-only hostile probe (856 checks) against a throwaway instance. |
| `npm --prefix backend run load -- --users 100 --seconds 40` | Load/soak test. `--redis`, `--real-limits`. |

---

## 1. Production configuration audit

### Proven by `test:prod-config` (real server, production mode)

| Requirement | Result |
|---|---|
| Local file email (`EMAIL_TRANSPORT=file`) | server **refuses to start** |
| Local file storage (`FILE_STORAGE=local`) | refuses to start |
| JWT secrets < 32 chars / identical / missing | refuses to start |
| No admin credentials / plaintext admin password | refuses to start |
| `PUBLIC_API_URL` http or missing | refuses to start |
| `ALLOWED_ORIGINS` http or empty | refuses to start |
| No SMTP host/from | refuses to start |
| `REDIS_URL` set but Redis unreachable | refuses to start (unless `REDIS_OPTIONAL=true`) |
| Plain HTTP to `/api` | **426** ; request through a TLS-terminating proxy (`X-Forwarded-Proto: https`) works |
| CORS | exact allow-list: listed origin gets the grant; `evil.example`, look-alike suffixes, `http://`, `null`, other ports get **403 and no CORS header**; preflight from an unlisted origin is not granted |
| Refresh cookie | `HttpOnly; Secure; SameSite=Strict; Path=/api/auth`; refresh token never in the JSON for cookie clients; auth responses `Cache-Control: no-store` |
| Email verification | cannot be disabled in production |
| `npm run seed` | refuses in production, **before connecting** |
| Secrets in the checklist tool output | none printed (asserted against freshly generated secrets) |

### Two real gaps the tests proved (not fixed; see findings F1, F2)

* **F1.** Only the exact string `NODE_ENV=production` activates production behaviour. With `NODE_ENV=prod` the server
  *started* with weak secrets, `http://` URLs, a localhost origin, file email and local storage.
* **F2.** Production starts with **no Cloudinary credentials**; every upload then fails with 503 at runtime.

### Checklist (variable names; run the tool for live status)

Legend: REQUIRED = server will not start or a core feature fails without it · OPTIONAL · UNSAFE = must not be set/valued
this way in production.

| Name | Class | Correct value |
|---|---|---|
| `NODE_ENV` | REQUIRED | exactly `production` |
| `MONGODB_URI` | REQUIRED | remote, authenticated, TLS (`mongodb+srv://…` or `tls=true`); **UNSAFE** if localhost or no credentials |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | REQUIRED | ≥32 random chars each, **different**, not placeholders |
| `PASSWORD_RESET_PEPPER` | recommended | independent third secret |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | REQUIRED | bcrypt cost ≥ 12 (never a plaintext password) |
| `PUBLIC_API_URL` | REQUIRED | public `https://…/api` |
| `ALLOWED_ORIGINS` (or `CLIENT_URL`) | REQUIRED | exact `https://` origins, no wildcard, no localhost |
| `TRUST_PROXY_HOPS` | REQUIRED (≥1 behind a proxy) | the exact number of proxies; `0` makes `req.secure` false so **every API call returns 426** and collapses per-IP limits |
| `SMTP_HOST`, `SMTP_FROM` | REQUIRED | real relay; `SMTP_USER`/`SMTP_PASSWORD` unless an internal open relay |
| `FILE_STORAGE` | REQUIRED | `cloudinary` (**UNSAFE**: `local`) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | REQUIRED (**not enforced at startup**, F2) | set |
| `REDIS_URL` | REQUIRED for 2+ instances; recommended always | `rediss://` with password |
| `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | OPTIONAL (all three or none) | stable pair across deployments |
| `EXPO_ACCESS_TOKEN` | OPTIONAL (recommended) | set |
| `GOOGLE_CLIENT_IDS`, `GOOGLE_WEB_CLIENT_ID` | OPTIONAL | **leave unset**: Google sign-in is not part of the product |
| `AUTO_JOIN_DEFAULT_WORKSPACE` | OPTIONAL | `false` (no automatic membership) |
| `PASSWORD_RECOVERY_MODE` | OPTIONAL | `email` (default) |
| `DEV_EMAIL_DIR`, `LOCAL_UPLOAD_DIR`, `SEED_ALLOW_REMOTE`, `ENV_FILE=…test…` | **UNSAFE if set** | unset |
| rate-limit / limits variables | OPTIONAL | positive numbers (see PRODUCTION.md §3) |

Also outside this repo (cannot be checked from here): web build variables `VITE_API_URL`, `VITE_SOCKET_URL` and mobile
`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SOCKET_URL`, `EXPO_PUBLIC_EAS_PROJECT_ID` must be `https://`/`wss`-capable production URLs
(they are baked into the bundles at build time). The static host needs its own CSP/HSTS headers.

---

## 2. Real-service readiness

**Every item below is NOT VERIFIED — REAL CREDENTIALS REQUIRED.** Automated tests used local storage, file-based email
and mocked push endpoints; those prove the application logic around the services, not the services.

Code paths reviewed: Cloudinary `services/fileStorage.js`, `routes/files.js`, `services/attachmentAccess.js`;
SMTP `services/emailService.js`; Web Push `services/webPush.js`; Expo `services/pushNotifications.js`.

Specific risks to confirm with the real service:
* **Cloudinary raw/video downloads:** links use `cloudinary.utils.private_download_url(publicId, format||undefined, …)`.
  Images are the common case; **documents (raw) and videos are unverified** (format handling, and whether this endpoint
  has API rate limits that matter at your volume). If it misbehaves the fix is local to `files.js`.
* **SMTP:** transport requires STARTTLS on ports ≠ 465, 5 s connect timeout. A failed verification email returns a generic
  500 and removes the pending code so the user can retry after 60 s.
* **Web Push:** subscription endpoints are allow-listed to FCM, Mozilla, Apple and Windows hosts (SSRF-safe). Subscriptions
  are removed on 404/410 from the push service.
* **Expo push:** tokens validated by pattern; `DeviceNotRegistered` tickets delete the token.

### Manual procedures

**Cloudinary**
1. Upload a PNG and a PDF in a private channel (web).
2. As a second member, open both; confirm they render/download.
3. Copy the attachment URL (it is `…/api/files/access/<id>?user=…&expires=…&signature=…`). Open it signed in as a third user
   who is **not** in the channel (swap `user=` for their id, or just try): must be **404**.
4. Leave the chat open > 5 minutes, click *Open original*: must work (client refreshes the link; no reload needed).
5. In Cloudinary's console confirm the asset type is **authenticated** and the raw `secure_url` is rejected without signature.
6. Remove the second member from the channel; their previously opened link must stop working (≤5 min) and a fresh request
   returns nothing.
7. Delete the message: link → 404; the asset disappears from Cloudinary (check the Media Library) within the cleanup interval.
8. Upload a video (MP4) and a `.docx`: confirm both open (this is the unverified raw/video path).

**SMTP**
1. Register a new account: the verification code arrives; the wrong code is refused; the right code completes registration.
2. Request a password reset: code arrives, works once, old sessions are signed out afterwards.
3. Request a workspace join as user B: the owner sees the in-app notification (email is **not** sent for joins in this
   build; if you want email for joins, that is a new feature).
4. Failure handling: set a wrong `SMTP_PASSWORD` on staging, request a code: the user sees a generic error (no code issued,
   no stack trace); logs show the delivery failure; restoring the password and retrying works.

**Web Push** (HTTPS origin, VAPID keys set)
1. Settings → enable browser alerts → grant permission → subscription row appears in `webpushsubscriptions`.
2. From another account send a DM with the tab closed: notification arrives; click opens the conversation.
3. Log out: notification must stop. **Known gap F4:** the server does not delete the subscription on logout; the browser
   unsubscribes itself, so test with the network off during logout and confirm what happens.
4. Delete the subscription in the browser's site settings; the next send must remove the dead row (404/410).

**Mobile push** (physical device, EAS build with credentials; Expo Go is not sufficient)
1. Enable push in Settings → `pushdevices` row appears with your user id.
2. Send a DM from another account with the app killed: notification arrives; tapping opens that DM.
3. Log out: no further notifications; the row is gone.
4. Account switching: log in as user B on the same phone → the token **moves** to B (one row, owner B). Send to A: nothing
   arrives on that phone. Send to B: arrives.
5. Reinstall/new token: the old token is replaced.

---

## 3. Mobile device QA plan (NOT VERIFIED — no physical device testing has been done)

Run on one iPhone and one Android, on a build pointed at **staging**. Use two accounts (A owner, B member) plus a third (C).

**Auth**: register (email code) · login · logout · password recovery (code by email) · airplane-mode launch keeps you signed in.
**Workspace**: A creates a workspace · B enters the code → "Request sent" and a *pending* row · A (mobile **and** web) sees the
request, accepts → B's phone shows "Request accepted" **without** pull-to-refresh · reject path → B sees "Declined · ask again
after <time>" · retry before 24 h is refused · after 24 h (staging: `JOIN_REQUEST_COOLDOWN_HOURS=0.01`) works · A rotates the code
→ the old code is refused, existing members/pending unaffected.
**Chat**: public channel (join from *Browse*) · private channel (C cannot see it) · DM · group DM (add, rename, leave) · send,
edit, delete · reaction · thread reply · image/PDF/video attachment (tap to open) · saved item appears on web.
**Realtime**: background → foreground (missed messages appear) · airplane mode 60 s then off · Wi-Fi → mobile data · mobile data
→ Wi-Fi · kill and relaunch · server restart (staging) · every case: no duplicate messages, unread badge correct, typing indicator clears.
**Notifications**: push while app foregrounded/backgrounded/killed · while logged out (must **not** arrive) · account switching on
the same phone (see §2) · lock-screen preview setting off hides text.
**Privacy check:** with C (not in the private channel or DM): nothing about those conversations appears in C's notification
shade, activity list, search, or saved items.

---

## 4. Load / soak

### What was run (this repository's own tool, single machine)

Client and server share one laptop-class machine; MongoDB local; no Redis; one API process; rate limits **lifted** to measure
raw capacity. Every user holds a WebSocket and acts every 1.5–4.5 s (55 % send, 20 % history, 10 % channel list/unread,
7 % react, 5 % unread-count, 3 % mark-read); every user is in the shared `general` channel, which is the worst case for
fan-out. Mid-run: 20 % of sockets drop and reconnect together, then a join-request burst and an upload burst.

| Users | Send p50 / p95 | History p95 | Delivery p50 / p95 | API CPU (1 core = 100 %) | API RSS peak | mongod CPU | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| 100 | 19 / 32 ms | 17 ms | 20 / 33 ms | 35 % avg | 406 MB | 15 % | 0.13 % (deliberate upload 429s) | healthy |
| 300 | 68 / 672 ms | 237 ms | 77 / 703 ms | 97 % avg | 724 MB | 45 % | 0.05 % | **at the edge** |
| 500 | 3.3 s / 9.3 s | 7.7 s | 3.3 s / 7.4 s | 125 % | 935 MB | 40 % | 0.04 % | **saturated** |
| 1,000 | 10 s / 32 s | 26 s | 10 s / 33 s | 124 % | 1.5 GB | 25 % | 8 % (450 sockets timed out connecting) | **overloaded; no crash, no log errors** |

**First bottleneck: the Node event loop on message fan-out**, not MongoDB (≤ 45 % of a core), not Redis (not in the path),
not the load generator (≤ 21 %). 500 users produced ~450,000 socket deliveries in 45 s. Reconnect catch-up, history,
unread counts, reactions and joins were all fast until the loop saturated; they slowed only because they queue behind it.

**What this does and does not tell you.** It shows the behaviour curve and the first limit of *one process on one laptop in a
worst-case workload*. It is **not** a capacity claim for your hardware. Untested: two or more instances behind a load
balancer with the Redis adapter (the intended way past this limit), a real network, a managed MongoDB, realistic channel-size
distributions, 24-hour soak, file-heavy traffic.

### Plan for a real load test (staging, production-like)

1. Provision: the intended number of API instances behind your LB (WebSocket upgrade on), managed MongoDB sized like
   production, managed Redis, Cloudinary/SMTP **sandboxes**. Keep rate limits **on**, and run the generator from separate machines.
2. `node backend/scripts/load/load-test.js --url …` currently self-hosts; extend it to target a URL and a seeded database (or run
   it on the staging host with `--redis`). Seed with realistic channel sizes (most channels < 50 members; a few 500+).
3. Steps: 100 → 500 → 1,000 concurrent users, 10 minutes each, then one **4-hour soak at 50 % of the best step**.
4. Record per step: p50/p95/p99 per operation, delivery latency, error rate, socket connect failures, Node CPU/RSS/event-loop
   lag (`perf_hooks.monitorEventLoopDelay`), MongoDB opcounters + CPU + connections + slow-query log (`slowms=100`), Redis CPU +
   memory + `INFO commandstats`, LB connection counts.
5. Pass criteria to agree up front, e.g. send p95 < 500 ms, delivery p95 < 1 s, error rate < 0.5 %, no unbounded RSS growth
   in the soak, reconnect storm of 20 % recovers < 10 s.
6. The next experiment after identifying the bottleneck is scale-out (2 → 4 instances, same Redis), not code changes.

---

## 5. Hostile security audit (read-only)

Method: `security-probe.js` runs seven different attackers (non-member, member-of-other-workspace, no workspace,
removed member, pending requester, ordinary member vs admin-only, and a fabricated SUPER_ADMIN flag) against private channels,
DMs, group DMs, attachments, threads, deleted messages, admin endpoints, invite codes, notifications, plus NoSQL-operator
injection through ~150 query/body combinations, forged/`alg:none` tokens, replay after logout, brute force, and socket
joins/spoofing. **856 checks passed.** The matrix covers ~85 REST routes × 5 attackers.

Honesty note: my first run of the probe reported "CRITICAL/HIGH" results. They were **my own test fixtures** (I had made the
"attacker" a member of the group DM and had her leave the workspace). I corrected the probe rather than reporting false
findings; the corrected run is the one above.

**CRITICAL: none. HIGH: none.**

| ID | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| F1 | MEDIUM | `NODE_ENV` typo (`prod`) silently selects development behaviour | `prod-config.test.js`: server started with weak secrets, http URLs, file email/local storage | refuse to start unless `NODE_ENV` ∈ {production, development, test} |
| F2 | MEDIUM | Production starts without Cloudinary credentials | test: started; uploads would 503 | validate the three variables in `validateConfig` |
| F3 | MEDIUM | No per-**account** login throttle | probe: 40 wrong passwords from 40 IPs, all 401, correct login then succeeded. Only per-IP (10/15 min) exists. bcrypt cost 12 + ≥10-char passwords limit practical impact | per-account counter (Redis) with temporary lockout or backoff |
| F4 | MEDIUM | Web-push subscriptions are not revoked server-side on logout / password change / reset / disable | probe: rows remain after logout and password change. Expo devices **are** revoked | delete the user's `WebPushSubscription` rows in the same places `revokePushDevices` is called |
| F5 | LOW | `GET /health` is unauthenticated and returns internal state (Redis error text, cleanup stats) | probe | expose only `{status}` publicly, or restrict to the LB/private network |
| F6 | LOW | Access log prints router-relative paths (`POST / 201`) with no client IP/user; auth failures and 403s are unattributable | probe: 238 ambiguous lines | log `req.originalUrl` (path only), IP, and user id |
| F7 | LOW | Password-recovery request timing likely reveals registered emails (existing account awaits an SMTP send; unknown returns immediately). **Code reasoning; not measured against real SMTP** | `passwordResets.js` | respond before sending, or equalise |
| F8 | LOW | The email-verification endpoint can mail a code to a registered address (bounded by 60 s/email and 10 per 15 min/IP) | code | acceptable; noted |
| F9 | LOW | A session evicted by the 11th login keeps its socket until the access token expires (≤ 15 min). Code reasoning | `authSessions.js`, `socketHandler.js` | disconnect on eviction |
| F10 | LOW | A few log calls print raw error objects (register/login/upload/avatar/audit); a Mongo duplicate-key error message can contain an email | `auth.js:70,117`, `files.js`, `users.js` | route them through `describeError` |
| F11 | INFO | `messages` has 16 indexes (some overlap) → write amplification | index listing | prune after load testing shows write pressure |
| F12 | INFO | Registering an Expo token already owned by another user moves it (needs knowing the token, which is unguessable) | code | none |
| F13 | INFO | Google routes exist but return 503 unless `GOOGLE_CLIENT_IDS` is set | code | leave the variables unset |

**Verified safe by the probe:** every private channel / DM / group DM / thread / attachment / saved / search / notification
route denies non-entitled users (403/404, or 200 with provably no protected content); workspace state cannot be altered by
non-admins; deleted messages are unreachable (history, search, saved, thread, edit); invite code is never returned to anyone
but admins (REST and sockets), before or after rotation; admin endpoints reject normal users, anonymous requests and a
database-flipped role; NoSQL operators in queries/bodies/params never produce 5xx or leakage; forged and `alg:none` tokens
are rejected; tokens and refresh tokens die on logout; another user's attachment signature is rejected; socket joins to
private channels, DMs, threads and foreign workspaces are refused for all five attacker types, and no protected content
reached any of their sockets, including live messages sent while they were connected.

---

## 6. Database and backup

* **Indexes:** `npm --prefix backend run db:indexes` was run against a throwaway database (17 collections created, output above;
  it is idempotent and non-destructive: `createIndexes`, never `syncIndexes`/drop). **When to run it:** (a) before the first
  production start of this release, in a quiet window, because `messages` gains 4 indexes and builds on a large collection
  take time; (b) after every later release that adds an index. The server also builds missing indexes at startup
  (`autoIndex` is on), so running the command first simply makes that a planned event instead of a surprise.
* **TTL indexes created by this release:** `notification_retention` (90 days) will **delete** existing notifications older than
  90 days the first time MongoDB's TTL monitor runs (≈60 s after creation). Take a backup first, or set
  `NOTIFICATION_RETENTION_DAYS=0` before the first start to defer.
* **Backups:** not configured by the application (infrastructure concern). Required: automated daily snapshots/PITR, retained
  ≥ 7 days, stored separately; **a restore rehearsal into a scratch cluster before go-live** (not done here).
* **Authentication / least privilege:** create an application user with `readWrite` on the `unichat` database only (that role
  includes `createIndex`, which `db:indexes` needs). No `dbAdmin`/`root` for the app. A separate restricted user for backups.
  The checker flags a `MONGODB_URI` without credentials as UNSAFE.
* **Connections:** no `maxPoolSize` is set (driver default 100/instance). Size `instances × pool` below the cluster limit.
  Observed: 105 connections at 1,000 simulated users on one instance.
* **Background jobs:** attachment cleanup runs every 15 min per instance under a database lease (`joblocks`; safe with N
  instances, crash-safe via lease expiry); abandoned storage deletions retry 8 times then log `manual cleanup needed`.
* **Migrations:** `StarredMessage → SavedMessage` runs idempotently at startup; no destructive migration.

---

## 7. Observability

Reviewed every `console.*` call (80+). Confirmed by the probe's log capture across ~900 requests: **no passwords, access or
refresh tokens, message text, attachment signatures or URLs were written to the log.** A malformed JSON body containing a
password produced a V8 parse message **without** the body fragment on this Node version (≥ 22; engines requires 22.12).

| Wanted | Present? |
|---|---|
| Authentication failures | **No dedicated log** (only an HTTP status line; F6). Admin login failures are in the audit log. |
| Authorization failures | status lines only (F6) |
| Socket errors | yes: `Socket handler "<event>" failed: <message>` |
| Database errors | yes (`describeError`, field names only) |
| Redis | yes: connected / lost / recovered, rate-limited error lines |
| SMTP failures | yes (no recipient) |
| Upload failures | yes |
| Background jobs | yes, plus `/health` → `cleanup` |

**Health endpoints:** `GET /health/live` = the process is up and the event loop answers (use for liveness/restart). `GET /health` =
MongoDB connected (503 if not), Redis status (200 with `degraded` if Redis is down so the LB keeps the instance), cleanup-job
stats. Neither checks SMTP, Cloudinary or push providers.

Recommended before launch: structured JSON logs with request id, client IP and user id; alerts on 5xx rate, `Redis connection
lost`, `manual cleanup needed`, `Unhandled promise rejection`, `/health` ≠ ok, and event-loop lag.
