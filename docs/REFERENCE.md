# Unichat reference (admin, recovery, notifications, API table, security notes)

Moved out of the root README. The root [README](../README.md) explains how the project runs and how it fits together.


## Project layout

```text
Unichat/
├── backend/   Express API, MongoDB models, Socket.IO, Cloudinary
├── web/       React + TypeScript + Vite client
```

## Implemented features

- JWT authentication, workspaces, invite codes, and membership
- Public/private channels, one-to-one DMs, and group DMs
- Messages, threads, reactions, mentions, unread counts, presence, and typing
- Channel and workspace management: join/leave, roles, invites, archive/restore, ownership transfer, group DM management
- Reliable delivery: cursor pagination, reconnect catch-up, idempotent sends, multi-device read state
- Image, video, and document attachments


## Requirements

- Node.js and npm
- MongoDB
- Cloudinary credentials for attachment uploads

## Local setup

See [setup, Google OAuth, Gmail OTP, and deployment instructions](docs/SETUP.md).

```sh
npm ci
npm --prefix backend ci
npm --prefix web ci
npm run setup:local
npm run seed:local
npm run dev
```

Open **http://localhost:5173**. Generated test account credentials are in `.local/test-accounts.json`; OTP emails are written to `.local/mail/`. The separate `.env.test.local` files preserve existing `.env` credentials. Local testing uses only `unichat_local_test` and does not erase application data.

Registration accepts any email domain by default, verifies ownership by email code, and lets users create or join their own workspaces. Google sign-in appears after configuring the backend client IDs. Password recovery emails a one-time code by default; the administrator approval workflow remains optional with `PASSWORD_RECOVERY_MODE=admin`.




### Browser notifications

Open Activity → Settings → Turn on browser alerts, then allow permission in the browser. This uses desktop notifications when the Unichat tab is in the background. Browser notifications require HTTPS or localhost. Workspace notification levels, mutes, and Do Not Disturb still apply. The Sounds and Show message preview checkboxes control the alert sound flag and whether message text appears in previews; actual sound playback depends on the browser and operating system.

For delivery after all tabs are closed, generate a VAPID key pair once with `npx web-push generate-vapid-keys` in `backend/`, then set `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, and `WEB_PUSH_SUBJECT` (`mailto:` address or HTTPS URL) in `backend/.env` and restart the backend. Keep the private key secret and retain the same pair across deployments. Without these keys, browser alerts only work while an open tab still receives Socket.IO events. Test closed-tab delivery in an actual supported browser on HTTPS or localhost.

## API overview

### Internal administration and password recovery

Configure `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` **only in `backend/.env`**. In an interactive backend terminal, run `npm run hash:admin-password`, enter a strong password without command-line arguments, and copy the resulting hash into `ADMIN_PASSWORD_HASH`. Do not put the password or hash in any `VITE_` or `EXPO_PUBLIC_` variable. The admin account is created or promoted only after a successful login using that server-side hash. Production startup requires both settings and an HTTPS `PUBLIC_API_URL`. Put the API behind a trusted HTTPS reverse proxy; production `/api` requests over plain HTTP are rejected. Optionally set a separate random `PASSWORD_RESET_PEPPER` (otherwise the server uses `JWT_SECRET` to protect recovery-code hashes). Restart the backend after changing these settings.

The administrator signs in at the normal login page and is directed to `/admin`. That account can access global admin APIs. By default, ordinary users can create workspaces and owners can delete their own workspace; set `WORKSPACE_CREATION=admin` to restrict creation. Existing workspace-level channel/message permissions remain separate from the global role. Automatic default-workspace membership is disabled for open registration and requires an explicit restricted-domain opt-in. Deleting a workspace hides its conversations and disconnects its active sockets; restore it from Admin → Workspaces. Deletion requires typing the exact workspace name.


Recovery administrator notifications are supported. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and an absolute `RECOVERY_APPROVAL_URL` in `backend/.env`. Admin -> Security -> Account Recovery manages the approver, email/in-app delivery, OTP lifetime, maximum attempts, and approval-link lifetime. Requests are stored before notification delivery; SMTP failures are recorded on the request and do not create duplicate requests. Approval links are hashed, single-use, expire, are bound to the administrator they were issued to, and open a confirmation page. **Approval never gives the requester a reset credential** (anyone can file a request for any email address): approving issues a one-time code that is emailed to the account holder's own address, or revealed only to the administrator for delivery after identity is verified out of band. Codes expire, lock after too many wrong attempts, and a successful reset revokes every session and push device. Recovery actions are recorded in the audit log. See [docs/PRODUCTION.md](docs/PRODUCTION.md#5-account-recovery).

The local integration checks use newly generated `unichat_admin_smoke_*` and `unichat_regression_*` MongoDB databases and remove them afterward. They never seed or clear the configured application database:

```powershell
cd backend
npm run test:admin
npm run test:regression-isolated
```

The existing `test:smoke` command still targets a separately running server and now requires `SMOKE_ADMIN_EMAIL` and `SMOKE_ADMIN_PASSWORD` in the test process to exercise privileged workspace creation. Do not run it against production.

All routes are under `/api`.

| Area | Routes |
|---|---|
| Authentication | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/password-resets/...` |
| Internal admin | `/admin/dashboard`, `/admin/workspaces`, `/admin/users`, `/admin/password-resets`, `/admin/recovery-settings`, `/admin/audit-logs`, `/admin/security` |
| Public recovery | `/auth/password-resets/request`, `/auth/password-resets/status`, `/auth/password-resets/verify`, `/auth/password-resets/complete`, `/auth/password-resets/approval` |
| Workspaces | `/workspaces` and `/workspaces/:workspaceId/...` |
| Channels | `/channels/workspace/:workspaceId`, `/channels`, `/channels/:channelId/...` |
| Messages | `/messages/channel/:channelId`, `/messages`, `/messages/:messageId/...` |
| DMs | `/dms?workspaceId=...`, `/dms`, `/dms/:dmId/messages` |
| Search | `/search?workspaceId=...&q=...` |
| Saved messages | `/saved` |
| Pins | `/channels/:channelId/pins`, `/messages/:messageId/pin` |
| Attachments | `/files/upload`, `/files/:uploadId`, short-lived `/files/access/:uploadId` |
| Activity | `/notifications` and `/notifications/preferences` |
| Users | `/users/profile/:userId`, `/users/profile`, `/users/search`, `/users/notification-settings`, `/users/push-token` |


## Security and storage notes

- Socket.IO credentials are sent in the `auth` payload; query-string tokens are not accepted. Message content is delivered only to rooms a user is authorized for, and access changes (leaving, removal) take effect on live sockets immediately. See [docs/SOCKET_SECURITY.md](docs/SOCKET_SECURITY.md).
- New attachment uploads are stored as authenticated Cloudinary assets. Every generated access link is short-lived and the backend checks current channel or DM membership before redirecting to Cloudinary.
- Cloudinary folders organize files; they do not provide authorization. Authorization comes from backend membership checks and authenticated delivery.
- Existing assets uploaded before authenticated delivery was introduced require a separate Cloudinary migration before they can be considered private.
- `npm run seed` clears and recreates application data. Do not run it against a database that contains data you need to keep.

## Checks


Backend API smoke test:

```powershell
cd backend
npm run test:smoke
```

Web TypeScript and production bundle:

```powershell
cd web
npm run build
```
