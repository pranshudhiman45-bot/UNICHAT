import assert from 'node:assert/strict';
import test from 'node:test';
import { isGroupedMessage } from './messageGrouping.ts';

const message = (senderId, createdAt, extra = {}) => ({ sender: { _id: senderId }, createdAt, ...extra });

test('groups only nearby consecutive messages from the same sender', () => {
  const first = message('a', '2026-09-30T10:00:00Z');
  assert.equal(isGroupedMessage(first, message('a', '2026-09-30T10:04:00Z')), true);
  assert.equal(isGroupedMessage(first, message('b', '2026-09-30T10:01:00Z')), false);
  assert.equal(isGroupedMessage(first, message('a', '2026-09-30T10:06:00Z')), false);
  assert.equal(isGroupedMessage(first, message('a', '2026-09-30T09:59:00Z')), false);
  assert.equal(isGroupedMessage(undefined, first), false);
});

test('keeps system and forwarded messages visually distinct', () => {
  const first = message('a', '2026-09-30T10:00:00Z');
  const second = message('a', '2026-09-30T10:01:00Z');
  assert.equal(isGroupedMessage(first, { ...second, isSystemMessage: true }), false);
  assert.equal(isGroupedMessage({ ...first, isSystemMessage: true }, second), false);
  assert.equal(isGroupedMessage(first, { ...second, forwardedFrom: { senderName: 'Sam' } }), false);
  assert.equal(isGroupedMessage({ ...first, forwardedFrom: { senderName: 'Sam' } }, second), false);
});
