# Socket.IO security audit

Scope: `backend/src/socket/socketHandler.js`, `backend/src/socket/rooms.js`, and every `io.to(...).emit(...)` in the
routes and services. Verified by `backend/scripts/socket-isolation.test.js`, `socket-security.test.js`,
`multi-instance.test.js` and `membership.test.js`.

## Principles

1. **The server is the source of truth for rooms.** On connect the server computes the sockets' rooms from the database
   (`authorizedRoomsFor`). A client never names a room it should be in; it can only *ask* to join one, and every join is
   re-authorized.
2. **Message content is only ever emitted to `channel:<id>`, `dm:<id>` or `thread:<id>` rooms.** The `workspace:<id>` room
   carries low-sensitivity events only (presence, profile changes, membership/role changes, public-channel metadata).
3. **Access changes take effect on live sockets immediately**, on every device and every API instance
   (`io.in('user:<id>').socketsJoin/socketsLeave` goes through the Redis adapter).
4. **Nothing a client sends can crash or starve the server.** Every handler is wrapped (`installSafeHandlers`):
   acknowledgements are always callable, ids must be 24-hex strings (so `{ "$ne": null }` never reaches a query), thrown
   errors are contained, and a per-socket token bucket drops floods and disconnects persistent abusers.
5. **Attachments never travel over sockets.** Socket payloads carry `url: ""` plus `urlRequired: true`; clients exchange
   `uploadId`s for short-lived, per-user URLs via `POST /api/files/urls`, which re-checks current membership.

## Rooms

| Room | Who is in it | Joined by |
|---|---|---|
| `user:<id>` | every socket of that user | automatically on connect (`user:join` only accepts your own id) |
| `workspace:<id>` | members of that workspace | automatically on connect; `workspace:join` re-checks membership |
| `channel:<id>` | members of the channel (any workspace member may *preview* a public channel after an explicit, authorized `channel:join`) | automatically for member channels; `channel:join` for public previews; server-side `grantChannel` on join/invite/create |
| `dm:<id>` | participants (1:1 and group) | automatically on connect; `dm:join`; server-side `grantDm` |
| `thread:<id>` | anyone who may read the parent message | `thread:join` after `getThreadContext` |

Revocation (`socket/rooms.js`): `revokeChannel` (leave/removal), `revokeDm` (group leave/removal), `revokeWorkspace`
(workspace leave/removal: all channel, DM, thread and workspace rooms). Thread rooms are revoked together with their
channel/DM.

## Client → server events

| Event | Who may emit | Authorization / validation | Can it spoof an id? | Notes |
|---|---|---|---|---|
| `user:join` | any authenticated socket | id must equal the socket's own user id | no | |
| `workspace:join` / `workspace:leave` | authenticated | membership of a live (non-deleted, non-archived) workspace | id must be a 24-hex string; objects rejected | |
| `channel:join` | authenticated | workspace membership + (private ⇒ channel membership) | same | public channels are previewable by workspace members by design |
| `channel:leave`, `dm:leave`, `thread:leave` | authenticated | none needed (only leaves) | validated | also emits a typing "stop" |
| `dm:join` | authenticated | participant of the DM **and** workspace member | same | |
| `thread:join` | authenticated | `getThreadContext`: can read the parent channel/DM | same | |
| `typing:start` / `typing:stop` | authenticated | the socket must already be **in** that room; room type whitelisted; ≤1 relay/second/room | `roomId` validated; relays only to a room the sender is in | server keeps no typing state (multi-instance safe) |
| `presence:update` | authenticated | status whitelist, `statusMessage` ≤100 chars | cannot target another user | flood-limited by the bucket |
| `message:read` | authenticated | socket must be in the room **and** the message must belong to that channel/DM | `messageId` verified against the room | read receipts are a product feature |
| `auth:refresh` | authenticated | new token must verify, belong to the same user and the same session | cannot swap identity | extends the connection without reconnecting |
| *anything else* | – | ignored | – | still counted against the flood limit |

## Server → client events (who receives what)

| Event | Audience (room) | Leaks? |
|---|---|---|
| `message:new` / `message:updated` | `channel:<id>` or `dm:<id>` (and `thread:<id>` for replies) | content only to authorized members; **attachment URLs and storage ids are stripped** |
| `message:deleted`, `message:reaction`, `message:pinned`, `message:thread_updated` | conversation room (+ thread room) | ids / counts only |
| `message:read_receipt` | conversation room | user id + message id |
| `typing:update` | conversation/thread room | user id, display name, avatar |
| `channel:created` | `workspace:<id>` for public channels; each member's `user:<id>` for private | private channel existence is never broadcast to non-members |
| `channel:updated` | `workspace:<id>` (public) / `channel:<id>` (private) | channel metadata |
| `channel:archived` | `workspace:<id>` (public) / `channel:<id>` (private) | channel id |
| `channel:invited`, `channel:removed`, `dm:created`, `dm:removed`, `dm:updated`, `dm:preferences` | the affected users' `user:<id>` (or the DM room) | |
| `channel:member_joined/left` | `channel:<id>` | user id |
| `workspace:updated` | `workspace:<id>` | name/description/icon only (**no invite code, no member list**) |
| `workspace:member_joined/left/updated`, `workspace:ownership_transferred` | `workspace:<id>` | user id / role |
| `workspace:removed`, `workspace:join_decided` | the affected user | |
| `notification:new`, `activity:changed`, `saved:changed`, `channel:read`, `dm:read` | `user:<id>` | the user's own data |
| `user:presence_update`, `user:profile_updated` | `workspace:<id>` of every shared workspace + self | status/profile of teammates only |
| `auth:expiring`, `auth:expired` | the socket itself | |

## Threats considered

| Threat | Result |
|---|---|
| A workspace member subscribes to a private channel / DM / group DM | refused at `*:join`; never auto-joined (isolation tests) |
| A member receives private content through the workspace room | no message content is ever emitted there |
| Forged room names in `typing`, `message:read` | only relayed for rooms the sender is in; ids validated |
| NoSQL operator injection through ids (`{ "$ne": null }`, arrays) | rejected before any query (fuzz test, 1,080 payloads) |
| `emit('typing:start', null)` or a non-function ack crashing the process | contained by the handler wrapper (this was a real remote crash before this audit) |
| Event flooding | token bucket (burst 60, 20/s), disconnect after 300 drops |
| Removed member keeps receiving | live revocation on all devices and instances (membership + multi-instance tests) |
| Stale token keeps a socket alive | token expiry timer closes the socket unless `auth:refresh` succeeds; revoked sessions fail `auth:refresh` |
| Cross-workspace leakage | rooms are derived per workspace membership; workspace removal revokes all of that workspace's rooms |
| Attachment URL replay from a socket payload | URLs are not sent over sockets; links are per-user, 5-minute, re-authorized |
| Cross-site WebSocket hijacking | credentials travel in the `auth` payload, not cookies |

## Known limits

* A user who may *preview* a public channel receives its live messages while their socket is in the room. That is the
  intended definition of "public".
* `message:read_receipt` and `typing:update` reveal to room members that you are reading/typing. Both are intentional
  product features.
* Socket.IO long-polling needs sticky sessions behind a load balancer. The web client prefers WebSocket first; mobile
  already does. Prefer WebSocket-only at the proxy if possible.
