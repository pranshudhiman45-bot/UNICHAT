# Unichat setup and release notes

## Local testing without external credentials

Use Node 22.12+ (validated with Node 24), npm, and a running local MongoDB on port 27017.

```sh
npm ci
npm --prefix backend ci
npm --prefix web ci
npm run setup:local
npm run seed:local
npm run dev
```


Run only one development setup at a time. Root `npm run dev` starts both API and web with `.env.test.local`. Alternatively, run `npm run dev` separately inside `backend` and `web`; these load their regular `.env` configuration. Starting both setups duplicates the API on port 4000. Stop the previous launcher with Ctrl+C before switching. If setting up SMTP, edit the backend env file used by your selected launcher and restart it.

Testing files:

- `backend/.env.test.local`: API, local MongoDB, generated secrets, file email and file storage.
- `web/.env.test.local`: public web URLs.
- `.local/mail/*.json`: local email inbox. Open the newest matching recipient/subject to read the code. No real messages are sent in file mode; no codes are returned by the API.
- `.local/uploads/`: local profile photos and attachments. Message downloads still use short-lived signatures and authorization.
- `.local/qa/`: browser screenshots.

These files are ignored by Git. Test credentials and code emails must not be deployed. File email/storage modes are rejected when `NODE_ENV=production`.


## Google sign-in

1. Configure the Google Auth Platform consent screen, audience, support email, and test users while the app is in testing.
2. Create an OAuth **Web application** client. Add `http://localhost:5173` as an authorized JavaScript origin, then add your real HTTPS origin for deployment. Include `http://127.0.0.1:5173` if using that address.
3. Set backend `GOOGLE_WEB_CLIENT_ID` to that ID. Set `GOOGLE_CLIENT_IDS` to the comma-separated allowlist of accepted IDs, including the Web ID. Restart the backend. The web sign-in button appears automatically.
4. The web implementation uses Google's button and an ID-token callback. It does not need a Google client secret or a redirect URI for an authorization-code exchange. The backend verifies signature, issuer, audience, expiry, verified email, and identifies accounts by Google's `sub`.

Existing password accounts require an emailed proof before Google linking. New Google accounts with third-party email addresses also require proof; a returning linked account is identified by its stable subject. The configured server administrator continues to use its server-managed password.

Sources: [Google server verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Google web button](https://developers.google.com/identity/gsi/web/guides/display-button), [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/), [native Google sign-in setup](https://react-native-google-signin.github.io/docs/setting-up/get-config-file).

## Gmail/Google Workspace email codes

Set the following **only in the backend**:

```dotenv
EMAIL_TRANSPORT=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-sender@example.com
SMTP_PASSWORD=your-google-app-password
SMTP_FROM=Unichat <your-sender@example.com>
PASSWORD_RECOVERY_MODE=email
REQUIRE_EMAIL_VERIFICATION=true
```

Enable Google 2-Step Verification and create an app password if your account/Workspace policy allows it. Use the app password, not your normal Google password. If app passwords are unavailable, use your organization's approved SMTP provider. The application uses STARTTLS on port 587. Configure sender-domain authentication and test inbox/spam delivery before launch.

Codes expire after 10 minutes, allow at most five guesses, and can only be used once. Verification requests have a 60-second resend cooldown plus IP limits. Codes use keyed hashes in MongoDB; the reset token is hashed and single-use. Password recovery returns the same response for missing and eligible accounts. A successful reset invalidates access/refresh sessions and active sockets. Passwords require at least 10 characters and a maximum of 72 UTF-8 bytes to avoid bcrypt truncation.

Source: [Google app passwords](https://support.google.com/accounts/answer/185833).

## Workspaces

Open registration does **not** grant access to anyone else's workspace. Users create their own workspace or join with an invite code. Creation provisions `general` and `random`. Names can repeat; generated slugs and invite codes are unique. Joining is idempotent and atomic for membership, including concurrent joins and repair of interrupted channel enrollment. Workspace owners/admins can edit details and rotate invite codes. Only the owner or global administrator can delete a workspace, with exact-name confirmation. Global administrators retain restore controls.

For a private company deployment, set `WORKSPACE_CREATION=admin`. Domain restrictions and legacy automatic enrollment are independently opt-in using `ALLOWED_REGISTRATION_DOMAIN` and `AUTO_JOIN_DEFAULT_WORKSPACE=true`. Do not enable automatic enrollment for an open public service. Existing users and workspace memberships are preserved; review legacy memberships before opening an existing company installation to the public.

## Production and scaling

Use `backend/.env.example` as the server configuration template. Set production secrets, MongoDB, admin credentials, SMTP, Cloudinary, HTTPS public API URL, and exact allowed web origins. Use the interactive `npm --prefix backend run hash:admin-password` command to generate the admin hash. Client env files contain public URLs/IDs only.

Build the web app with `npm --prefix web run build` and serve `web/dist` with SPA fallback. Keep frontend and API on the same site (for example `chat.example.com` and `api.example.com`) for the Strict refresh cookie; unrelated frontend/API domains are not supported by the default cookie policy. Terminate TLS at a trusted proxy and set `TRUST_PROXY_HOPS` to its actual topology. Forward WebSocket upgrades and never expose an API instance through a path that bypasses the trusted proxy assumptions.

`REDIS_URL` enables shared rate-limit counters and the Socket.IO Redis adapter. All API instances must share MongoDB, Redis, signing secrets, allowed origins, and public URLs. Keep sticky routing for Socket.IO's HTTP polling transport. Presence checks use adapter-wide sockets. OTPs, refresh sessions, and recovery state live in MongoDB, so they survive API restarts. Health endpoints are `/health/live` (process) and `/health` (MongoDB/Redis readiness). SIGTERM drains connections. Monitor API latency, failed SMTP sends, database/Redis health, and storage errors; back up MongoDB and retain stable signing/VAPID keys.

The current schema embeds workspace/channel membership in documents. It is suitable for modest teams, but not an unlimited-member claim: large workspaces need a separate membership collection, pagination of member lists, and measured load testing. Typing indicators remain ephemeral per API worker; do not use them as durable state. SMTP is synchronous with bounded timeouts; move delivery to a durable queue with retries for sustained traffic. Real deployments also need validated backup restoration, monitoring, retention requirements, and operational ownership.

## Checks and remaining release gates

```sh
npm run check
npm --prefix backend run test:auth
npm --prefix backend run test:startup
npm --prefix backend run test:admin
npm --prefix backend run test:regression-isolated
# Requires redis-server on PATH; launches its own ephemeral Redis:
npm --prefix backend run test:redis
# With local services running:
npm run test:e2e
```


A two-instance Redis regression verifies shared rate limiting and cross-instance message delivery. Backend integration suites use randomly named disposable MongoDB databases and remove them afterward. Browser tests use the local test database and fictional accounts. Google success-path tests mock only the provider verifier; invalid token tests use the real verification library. Live OAuth, SMTP delivery, Cloudinary, native device behavior, push credentials/delivery, and production load behavior must be tested with your accounts/infrastructure.



The application implements team messaging, not every Slack product feature. Voice/video meetings, enterprise SSO/SCIM, compliance exports, billing, and organization-wide policy enforcement are not implemented by this change.
