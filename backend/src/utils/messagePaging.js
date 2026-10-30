const mongoose = require('mongoose');
const Message = require('../models/Message');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SYNC_LIMIT = 200;

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function parseDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`${label} must be a valid date`), { status: 400 });
  return date;
}

const populateMessage = (query) => query
  .populate('sender', 'displayName avatar username status')
  .populate('thread.participants', 'displayName avatar');

// Keyset pagination on (createdAt, _id): stable when many messages share a timestamp, so older pages
// never skip or repeat a message. `before` alone (a date) remains supported for older clients.
async function loadPage(scope, query) {
  const limit = parseLimit(query.limit);
  const filter = { ...scope, 'thread.parentMessage': null, isDeleted: false };
  if (query.before) {
    const before = parseDate(query.before, 'before');
    if (query.beforeId) {
      if (!mongoose.isValidObjectId(query.beforeId)) throw Object.assign(new Error('beforeId is invalid'), { status: 400 });
      filter.$or = [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: query.beforeId } }];
    } else {
      filter.createdAt = { $lt: before };
    }
  }
  const rows = await populateMessage(Message.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1)).lean();
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  const oldest = messages[0];
  return { messages, hasMore, nextCursor: hasMore && oldest ? { before: oldest.createdAt, beforeId: oldest._id } : null };
}

// Everything that changed since `since`: new, edited, reacted-to and deleted (as tombstones) messages.
// Clients use it after a reconnect so the database, not socket delivery, is the source of truth.
async function loadChanges(scope, query) {
  const since = parseDate(query.since, 'since');
  const serverTime = new Date();
  const rows = await populateMessage(Message.find({ ...scope, 'thread.parentMessage': null, updatedAt: { $gte: since } }).sort({ updatedAt: 1, _id: 1 }).limit(SYNC_LIMIT + 1)).lean();
  const truncated = rows.length > SYNC_LIMIT;
  const messages = rows.slice(0, SYNC_LIMIT).map((message) => (message.isDeleted ? { _id: message._id, isDeleted: true, channel: message.channel, dm: message.dm } : message));
  return { messages, truncated, serverTime };
}

module.exports = { loadPage, loadChanges };
