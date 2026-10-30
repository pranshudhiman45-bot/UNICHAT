const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { validAdminToken } = require('../services/adminSecurity');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');
const { getThreadContext } = require('../middleware/authorization');

const { emitToTeammates } = require('../services/presence');
const { authorizedRoomsFor } = require('./rooms');
const mongoose = require('mongoose');
const noop = () => {};
// Only plain 24-hex ids (as strings) are accepted from clients; objects like { $ne: null } never reach a query.
const idArg = (value) => (typeof value === 'string' && mongoose.isValidObjectId(value) && value.length === 24 ? value : null);
const shape = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// A single malformed event from an authenticated client must never be able to take the server down, so
// every handler is wrapped: the acknowledgement is always callable, thrown errors are contained, and each
// socket has a token bucket that drops floods (and disconnects persistent abusers).
const BUCKET_CAPACITY = Number(process.env.SOCKET_EVENT_BURST || 60);
const BUCKET_REFILL_PER_SECOND = Number(process.env.SOCKET_EVENT_RATE || 20);
const ABUSE_DISCONNECT_AFTER = 300;
function installSafeHandlers(socket) {
  const register = socket.on.bind(socket);
  let tokens = BUCKET_CAPACITY; let last = Date.now(); let dropped = 0;
  socket.on = (event, handler) => register(event, (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : noop;
    if (event !== 'disconnect') {
      const now = Date.now(); tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - last) / 1000) * BUCKET_REFILL_PER_SECOND); last = now;
      if (tokens < 1) {
        if (++dropped > ABUSE_DISCONNECT_AFTER) socket.disconnect(true);
        try { ack({ ok: false, error: 'Too many requests' }); } catch { /* ack misbehaved */ }
        return undefined;
      }
      tokens -= 1;
    }
    try {
      const result = handler(args[0], ack);
      if (result && typeof result.catch === 'function') result.catch((error) => console.error(`Socket handler "${event}" failed:`, error.message));
    } catch (error) {
      console.error(`Socket handler "${event}" failed:`, error.message);
    }
    return undefined;
  });
}

const PRESENCE_GRACE_MS = Number(process.env.PRESENCE_GRACE_MS ?? 8000);

module.exports = (io) => {
  async function verifyToken(token) {
    if (!token || typeof token !== 'string') throw new Error('No token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('+refreshSessions');
    if (!user || user.accountStatus === 'disabled' || !validAdminToken(user, decoded) || (decoded.ver || 0) !== (user.sessionVersion || 0) || (decoded.sid && !user.refreshSessions.some((session) => session.sessionId === decoded.sid))) throw new Error('Unauthorized');
    return { user, decoded };
  }

  io.use(async (socket, next) => {
    try {
      const { user, decoded } = await verifyToken(socket.handshake.auth.token);
      socket.userId = user._id.toString();
      socket.data.userId = socket.userId;
      socket.user = user;
      socket.data.sessionId = decoded.sid || null;
      socket.data.accessExpiresAt = decoded.exp * 1000;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    installSafeHandlers(socket);
    // Access tokens are short-lived. Shortly before expiry the server asks the client to send a fresh
    // token over the same connection (auth:refresh); only if that does not happen is the socket closed.
    let warnTimer; let expiryTimer;
    const armExpiry = () => {
      clearTimeout(warnTimer); clearTimeout(expiryTimer);
      const remaining = Math.max(1, socket.data.accessExpiresAt - Date.now());
      warnTimer = setTimeout(() => socket.emit('auth:expiring'), Math.min(Math.max(remaining - 60000, 0), 2147483647));
      expiryTimer = setTimeout(() => { socket.emit('auth:expired'); socket.disconnect(true); }, Math.min(remaining, 2147483647));
      warnTimer.unref?.(); expiryTimer.unref?.();
    };
    armExpiry();
    socket.on('auth:refresh', async (payload, acknowledge) => {
      try {
        const { user, decoded } = await verifyToken(payload?.token);
        if (String(user._id) !== userId || (decoded.sid || null) !== socket.data.sessionId) throw new Error('Session mismatch');
        socket.data.accessExpiresAt = decoded.exp * 1000;
        socket.user = user;
        armExpiry();
        acknowledge?.({ ok: true, expiresAt: socket.data.accessExpiresAt });
      } catch {
        acknowledge?.({ ok: false });
      }
    });
    socket.join('user:' + userId);

    socket.on('user:join', (requestedUserId, acknowledge) => {
      const allowed = String(requestedUserId) === String(userId);
      if (allowed) socket.join('user:' + userId);
      acknowledge?.({ ok: allowed, error: allowed ? undefined : 'Cannot join another user room' });
    });

    // Rooms are derived from the database, never from client input. Message rooms
    // (channel:/dm:) are joined only for conversations the user belongs to.
    void authorizedRoomsFor(userId).then((names) => { if (socket.connected) socket.join(names); }).catch(() => {});
    // Only a user who is actually offline becomes online; a chosen "away"/"busy" survives reconnects.
    void User.findOneAndUpdate({ _id: userId, status: 'offline' }, { status: 'online', lastSeen: new Date() })
      .then((previous) => previous && emitToTeammates(io, userId, 'user:presence_update', { userId, status: 'online' }))
      .catch(() => {});

    socket.on('workspace:join', async (rawId, acknowledge) => {
      const workspaceId = idArg(rawId);
      if (!workspaceId) return acknowledge({ ok: false, error: 'Invalid workspace' });
      try {
        const workspace = await Workspace.findOne({ _id: workspaceId, 'members.user': userId, deletedAt: null, isArchived: false }).select('_id');
        if (!workspace) return acknowledge?.({ ok: false, error: 'Not a workspace member' });
        socket.join('workspace:' + workspaceId);
        acknowledge?.({ ok: true });
      } catch {
        acknowledge?.({ ok: false, error: 'Workspace authorization failed' });
      }
    });
    socket.on('workspace:leave', (rawId) => { const workspaceId = idArg(rawId); if (workspaceId) socket.leave('workspace:' + workspaceId); });

    socket.on('channel:join', async (rawId, acknowledge) => {
      const channelId = idArg(rawId);
      if (!channelId) return acknowledge({ ok: false, error: 'Invalid channel' });
      try {
        const channel = await Channel.findById(channelId).select({ workspace: 1, type: 1, members: { $elemMatch: { user: userId } } });
        const workspace = channel && await Workspace.findOne({ _id: channel.workspace, 'members.user': userId, deletedAt: null, isArchived: false }).select('_id');
        const isChannelMember = channel?.isMember(userId);
        if (!channel || !workspace || (channel.type === 'private' && !isChannelMember)) {
          return acknowledge?.({ ok: false, error: 'Not authorized for this channel' });
        }
        socket.join('channel:' + channelId);
        acknowledge?.({ ok: true, isMember: isChannelMember });
      } catch {
        acknowledge?.({ ok: false, error: 'Channel authorization failed' });
      }
    });
    socket.on('channel:leave', (rawId) => {
      const channelId = idArg(rawId); if (!channelId) return;
      stopTypingIn('channel:' + channelId);
      socket.leave('channel:' + channelId);
    });

    socket.on('dm:join', async (rawId, acknowledge) => {
      const dmId = idArg(rawId);
      if (!dmId) return acknowledge({ ok: false, error: 'Invalid conversation' });
      try {
        const dm = await DirectMessage.findOne({ _id: dmId, participants: userId }).select('_id workspace');
        const workspace = dm && await Workspace.findOne({ _id: dm.workspace, 'members.user': userId, deletedAt: null, isArchived: false }).select('_id');
        if (!dm || !workspace) return acknowledge?.({ ok: false, error: 'Not a DM participant' });
        socket.join('dm:' + dmId);
        acknowledge?.({ ok: true });
      } catch {
        acknowledge?.({ ok: false, error: 'DM authorization failed' });
      }
    });
    socket.on('dm:leave', (rawId) => {
      const dmId = idArg(rawId); if (!dmId) return;
      stopTypingIn('dm:' + dmId);
      socket.leave('dm:' + dmId);
    });

    socket.on('thread:join', async (rawId, acknowledge) => {
      const parentMessageId = idArg(rawId);
      if (!parentMessageId) return acknowledge({ ok: false, error: 'Invalid thread' });
      try {
        const access = await getThreadContext(parentMessageId, userId);
        if (access.error) return acknowledge?.({ ok: false, error: access.error });
        socket.join('thread:' + access.parent._id);
        acknowledge?.({ ok: true });
      } catch {
        acknowledge?.({ ok: false, error: 'Thread authorization failed' });
      }
    });
    socket.on('thread:leave', async (rawId) => {
      const parentMessageId = idArg(rawId); if (!parentMessageId) return;
      const access = await getThreadContext(parentMessageId, userId).catch(() => null);
      socket.leave('thread:' + (access?.parent?._id || parentMessageId));
    });

    // Typing is relayed, not stored. The server keeps no cross-user state, so it behaves identically on every
    // instance behind the Redis adapter. Clients expire a typist ~5s after their last "start", and the
    // per-socket set below makes sure a disconnect emits "stop" for exactly the rooms this socket typed in.
    const typingIn = new Map(); // room key -> last start timestamp (this socket only)
    const emitTyping = (key, roomType, roomId, action) => {
      socket.to(key).emit('typing:update', { roomId, roomType, userId, displayName: socket.user.displayName, avatar: socket.user.avatar, action, typingUsers: action === 'start' ? [userId] : [] });
    };
    socket.on('typing:start', (payload) => {
      const { roomType, roomId } = shape(payload);
      if (!['channel', 'dm', 'thread'].includes(roomType) || !idArg(roomId)) return;
      const key = roomType + ':' + roomId;
      if (!socket.rooms.has(key)) return;
      const last = typingIn.get(key) || 0;
      if (Date.now() - last < 1000) return; // flood protection: at most one relay per second per room
      typingIn.set(key, Date.now());
      emitTyping(key, roomType, roomId, 'start');
    });
    socket.on('typing:stop', (payload) => {
      const { roomType, roomId } = shape(payload);
      if (!['channel', 'dm', 'thread'].includes(roomType) || !idArg(roomId)) return;
      const key = roomType + ':' + roomId;
      if (socket.rooms.has(key) && typingIn.delete(key)) emitTyping(key, roomType, roomId, 'stop');
    });
    const stopTypingIn = (key) => { if (typingIn.delete(key)) { const [roomType, ...rest] = key.split(':'); emitTyping(key, roomType, rest.join(':'), 'stop'); } };
    const stopAllTyping = () => { for (const key of typingIn.keys()) { const [roomType, ...rest] = key.split(':'); emitTyping(key, roomType, rest.join(':'), 'stop'); } typingIn.clear(); };

    socket.on('presence:update', async (payload) => {
      const { status, statusMessage } = shape(payload);
      if (!['online', 'away', 'busy', 'offline'].includes(status)) return;
      try {
        const message = typeof statusMessage === 'string' ? statusMessage.slice(0, 100) : undefined;
        await User.findByIdAndUpdate(userId, { status, ...(message !== undefined ? { statusMessage: message } : {}) });
        await emitToTeammates(io, userId, 'user:presence_update', { userId, status, statusMessage: message });
      } catch { /* Transient persistence errors must not crash the socket server. */ }
    });
    // Read receipts are relayed only for a message that really belongs to the room the sender is in.
    socket.on('message:read', async (payload) => {
      const { channelId, dmId, messageId } = shape(payload);
      const scopeId = idArg(channelId) || idArg(dmId); const message = idArg(messageId);
      if (!scopeId || !message || (channelId && dmId)) return;
      const room = channelId ? 'channel:' + scopeId : 'dm:' + scopeId;
      if (!socket.rooms.has(room)) return;
      const belongs = await Message.exists({ _id: message, ...(channelId ? { channel: scopeId } : { dm: scopeId }) }).catch(() => null);
      if (belongs) socket.to(room).emit('message:read_receipt', { userId, messageId: message });
    });

    socket.on('disconnect', async () => {
      clearTimeout(warnTimer); clearTimeout(expiryTimer);
      // A short grace period absorbs reconnects (network switch, sleep/wake) without flickering offline.
      const grace = setTimeout(async () => {
        try {
          // Redis adapter fetchSockets includes connections on other API instances.
          if (!(await io.in(`user:${userId}`).fetchSockets()).length) {
            const lastSeen = new Date();
            await User.findByIdAndUpdate(userId, { status: 'offline', lastSeen });
            await emitToTeammates(io, userId, 'user:presence_update', { userId, status: 'offline', lastSeen });
          }
        } catch { /* Presence recovers on the next connection. */ }
      }, PRESENCE_GRACE_MS);
      grace.unref?.();
      stopAllTyping();
    });
  });
};
