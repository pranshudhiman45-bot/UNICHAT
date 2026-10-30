const express = require('express');
const { describeError } = require('../utils/logSafe');
const router = express.Router();
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const Message = require('../models/Message');
const Channel = require('../models/Channel');
const Workspace = require('../models/Workspace');
const DirectMessage = require('../models/DirectMessage');
const User = require('../models/User');
const Notification = require('../models/Notification');
const StoredAttachment = require('../models/StoredAttachment');
const { MAX_RICH_CONTENT_LENGTH, normalizeRichContent, richContentToText } = require('../utils/richContent');
const { authenticate } = require('../middleware/auth');
const { limiter } = require('../services/redis');
const { getChannelContext, getDMContext, getThreadContext, getMessageContext } = require('../middleware/authorization');
const { MAX_ATTACHMENTS, destroyAsset } = require('../services/fileStorage');
const { createNotifications } = require('../services/notifications');
const { stripAttachmentLinks } = require('../services/attachmentAccess');
const { loadPage, loadChanges } = require('../utils/messagePaging');

const PAGE_SIZE = 50;
const MAX_THREAD_PARTICIPANTS = 200;
const MAX_THREAD_REPLIES_PER_RESPONSE = Number(process.env.MAX_THREAD_REPLIES_PER_RESPONSE || 1000);
// Per-user send budget (the authenticated user id is the key): generous for people, tight for scripts.
const sendLimiter = limiter('message-send', { windowMs: 60 * 1000, limit: Number(process.env.MESSAGE_SEND_LIMIT_PER_MINUTE || 60), keyGenerator: (req) => `u:${req.userId}`, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'You are sending messages too quickly. Please slow down.' } });
router.param('messageId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Message not found' }));
router.param('channelId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Channel not found' }));

const mentionTokenRegex = /<@([a-f\d]{24})>/gi;
const legacyMentionRegex = /@([a-zA-Z0-9_.-]+)/g;

async function extractMentions(content, workspaceId) {
  if (!content) return [];
  const workspace = await Workspace.findById(workspaceId).select('members');
  if (!workspace) throw Object.assign(new Error('Workspace not found'), { status: 404 });
  const memberIds = workspace.members.map((member) => member.user.toString());
  const tokenIds = [...content.matchAll(mentionTokenRegex)].map((match) => match[1].toLowerCase());
  const invalidToken = tokenIds.find((id) => !memberIds.includes(id));
  if (invalidToken) throw Object.assign(new Error('Mentioned user is not a member of this workspace'), { status: 400 });

  const withoutTokens = content.replace(mentionTokenRegex, ' ');
  const usernames = [...withoutTokens.matchAll(legacyMentionRegex)].map((match) => match[1].toLowerCase());
  const legacyUsers = usernames.length
    ? await User.find({ username: { $in: usernames }, _id: { $in: memberIds } }).select('_id username')
    : [];
  return [...new Set([
    ...tokenIds,
    ...legacyUsers.map((user) => user._id.toString()),
  ])];
}


function reactionPayload(message) {
  return message.reactions.map((reaction) => ({
    emoji: reaction.emoji,
    users: reaction.users.map((user) => user.toString()),
    count: reaction.users.length,
  }));
}

async function findPriorSend(senderId, clientMessageId, { channelId, dmId }) {
  const prior = await Message.findOne({ sender: senderId, clientMessageId });
  if (!prior) return null;
  const sameConversation = channelId ? String(prior.channel) === String(channelId) : String(prior.dm) === String(dmId);
  if (!sameConversation) return 'conflict';
  const uploadIds = (prior.attachments || []).map((attachment) => attachment.uploadId).filter(Boolean);
  if (uploadIds.length) await StoredAttachment.updateMany({ _id: { $in: uploadIds }, status: 'staged' }, { $set: { status: 'attached', message: prior._id } });
  return Message.findById(prior._id).populate('sender', 'displayName avatar username status').populate('thread.participants', 'displayName avatar username status');
}

// GET /api/messages/channel/:channelId?limit=&before=&beforeId=
// Reading history never marks the channel read; clients call PUT /channels/:id/mark-read explicitly.
router.get('/channel/:channelId', authenticate, async (req, res) => {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId, { light: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { channel } = access;
    const serverTime = new Date();
    const memberData = channel.members.find((member) => member.user.toString() === req.userId);
    const lastReadAt = memberData?.lastRead || null;
    const [page, unreadCount] = await Promise.all([
      loadPage({ channel: channel._id }, req.query),
      memberData ? Message.countDocuments({ channel: channel._id, 'thread.parentMessage': null, createdAt: { $gt: memberData.lastRead }, sender: { $ne: req.userId }, isDeleted: false }) : 0,
    ]);
    res.json({ messages: page.messages, hasMore: page.hasMore, nextCursor: page.nextCursor, unreadCount, lastReadAt, serverTime });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/messages/channel/:channelId/sync?since=ISO - changes since a reconnect (see loadChanges).
router.get('/channel/:channelId/sync', authenticate, async (req, res) => {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId, { light: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    res.json(await loadChanges({ channel: access.channel._id }, req.query));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to sync messages' });
  }
});

// GET /api/messages/:messageId/thread and legacy /api/messages/thread/:parentId
async function getThread(req, res) {
  try {
    const access = await getThreadContext(req.params.messageId || req.params.parentId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const parent = await Message.findById(access.parent._id)
      .populate('sender', 'displayName avatar username status')
      .populate('thread.participants', 'displayName avatar username status')
      .lean();

    // A thread is bounded per response: the oldest MAX_THREAD_REPLIES_PER_RESPONSE replies (conversation order). Threads
    // larger than that report `truncated: true` so clients can say so instead of silently dropping replies.
    const replies = await Message.find({
      'thread.parentMessage': access.parent._id,
      isDeleted: false,
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_THREAD_REPLIES_PER_RESPONSE + 1)
      .populate('sender', 'displayName avatar username status')
      .lean();
    const truncated = replies.length > MAX_THREAD_REPLIES_PER_RESPONSE;
    if (truncated) replies.pop();

    res.json({ parent, replies, truncated, replyCount: parent.thread?.replyCount || replies.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
}

router.get('/:messageId/thread', authenticate, getThread);
router.get('/thread/:parentId', authenticate, getThread);

// POST /api/messages - Send message
router.post('/', authenticate, sendLimiter, [
  body('content').optional().isString().isLength({ max: 40000 }).withMessage('Message is too long (limit 40,000 characters)'),
  body('formattedContent').optional().isString().isLength({ max: MAX_RICH_CONTENT_LENGTH }),
  body('channelId').optional().isMongoId(),
  body('dmId').optional().isMongoId(),
  body('workspaceId').isMongoId(),
  body('parentMessageId').optional().isMongoId(),
  body('attachmentIds').optional().isArray({ max: MAX_ATTACHMENTS }),
  body('clientMessageId').optional().matches(/^[A-Za-z0-9_-]{8,64}$/).withMessage('clientMessageId must be 8-64 URL-safe characters'),
], async (req, res) => {
  let stagedAttachments = [];
  let messageCreated = false;
  try {
    const validation = validationResult(req);
    if (!validation.isEmpty()) return res.status(400).json({ error: validation.array({ onlyFirstError: true })[0].msg });
    const { clientMessageId } = req.body;
    const { workspaceId, channelId, dmId, content, formattedContent, attachmentIds = [], attachments } = req.body;
    const normalizedRichContent = normalizeRichContent(formattedContent);
    if (formattedContent && !normalizedRichContent) return res.status(400).json({ error: 'Invalid formatted content' });
    const normalizedContent = normalizedRichContent ? richContentToText(normalizedRichContent).trim() : (typeof content === 'string' ? content.trim() : '');
    let { parentMessageId } = req.body;

    if (channelId && dmId) {
      return res.status(400).json({ error: 'Provide either channelId or dmId, not both' });
    }
    if (!channelId && !dmId) {
      return res.status(400).json({ error: 'channelId or dmId required' });
    }
    if (attachments?.length && !attachmentIds.length) {
      return res.status(400).json({ error: 'Files must be uploaded before they can be attached' });
    }
    if (!normalizedContent && !attachmentIds.length) {
      return res.status(400).json({ error: 'Message must have content or attachments' });
    }
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS || attachmentIds.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ error: `Up to ${MAX_ATTACHMENTS} valid attachment IDs are allowed` });
    }
    if (new Set(attachmentIds.map(String)).size !== attachmentIds.length) {
      return res.status(400).json({ error: 'Duplicate attachment IDs are not allowed' });
    }

    let messageWorkspaceId = workspaceId;
    let dmAccess = null;

    // Membership verification
    if (channelId) {
      const access = await getChannelContext(channelId, req.userId, { requireMembership: true, writable: true, light: true });
      if (access.error) return res.status(access.status).json({ error: access.error });
      if (String(workspaceId) !== String(access.workspace._id)) {
        return res.status(400).json({ error: 'workspaceId does not match channel workspace' });
      }
      messageWorkspaceId = access.workspace._id;
    } else if (dmId) {
      dmAccess = await getDMContext(dmId, req.userId, { light: true });
      if (dmAccess.error) return res.status(dmAccess.status).json({ error: dmAccess.error });
      if (String(workspaceId) !== String(dmAccess.workspace._id)) {
        return res.status(400).json({ error: 'workspaceId does not match conversation workspace' });
      }
      messageWorkspaceId = dmAccess.workspace._id;
    }

    if (clientMessageId) {
      const prior = await findPriorSend(req.userId, clientMessageId, { channelId, dmId });
      if (prior === 'conflict') return res.status(409).json({ error: 'clientMessageId was already used for a different message' });
      if (prior) return res.status(200).json({ message: prior, duplicate: true });
    }

    if (parentMessageId) {
      const candidate = await Message.findById(parentMessageId).select('channel dm workspace isDeleted thread');
      const parent = candidate?.thread?.parentMessage
        ? await Message.findById(candidate.thread.parentMessage).select('channel dm workspace isDeleted thread')
        : candidate;
      const sameContext = channelId
        ? String(parent?.channel) === String(channelId)
        : String(parent?.dm) === String(dmId);
      if (!parent || parent.isDeleted || !sameContext || String(parent.workspace) !== String(messageWorkspaceId)) {
        return res.status(400).json({ error: 'Parent message does not belong to this conversation' });
      }
      parentMessageId = parent._id.toString();
    }

    if (attachmentIds.length) {
      stagedAttachments = await StoredAttachment.find({
        _id: { $in: attachmentIds },
        workspace: messageWorkspaceId,
        uploadedBy: req.userId,
        ...(channelId ? { channel: channelId, dm: null } : { dm: dmId, channel: null }),
        parentMessage: parentMessageId || null,
        status: 'staged',
      });
      if (stagedAttachments.length !== attachmentIds.length) {
        return res.status(400).json({ error: 'One or more attachments are invalid, expired, or not owned by you' });
      }
    }

    const messageData = {
      workspace: messageWorkspaceId,
      sender: req.userId,
      content: normalizedContent,
      ...(normalizedRichContent ? { formattedContent: JSON.stringify(normalizedRichContent) } : {}),
      attachments: stagedAttachments.map((attachment) => ({
        uploadId: attachment._id,
        type: attachment.type,
        url: attachment.url,
        secureUrl: attachment.url,
        publicId: attachment.publicId,
        name: attachment.originalName,
        size: attachment.size,
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
        format: attachment.format,
        resourceType: attachment.resourceType,
        accessMode: attachment.accessMode,
      })),
    };

    if (channelId) messageData.channel = channelId;
    if (dmId) messageData.dm = dmId;
    if (clientMessageId) messageData.clientMessageId = clientMessageId;

    if (parentMessageId) {
      messageData.thread = { parentMessage: parentMessageId };
    }

    messageData.mentions = await extractMentions(normalizedContent, workspaceId);

    let message;
    try {
      message = await Message.create(messageData);
    } catch (error) {
      // Two identical requests raced: the loser returns the winner's message instead of failing.
      if (error?.code === 11000 && clientMessageId) {
        const prior = await findPriorSend(req.userId, clientMessageId, { channelId, dmId });
        if (prior && prior !== 'conflict') return res.status(200).json({ message: prior, duplicate: true });
      }
      throw error;
    }
    messageCreated = true;
    // Attachment ownership is not best-effort: until it is recorded, the orphan sweeper could delete these files.
    if (stagedAttachments.length) {
      await StoredAttachment.updateMany(
        { _id: { $in: stagedAttachments.map((attachment) => attachment._id) } },
        { $set: { status: 'attached', message: message._id } },
      );
    }
    let populatedMessage = null;
    let updatedParent = null;
    // The message is committed. Everything below is best-effort: a failure here must never turn a stored
    // message into a 500, or the client's retry would look like a failed send.
    try {

    // If reply, update parent thread
    if (parentMessageId) {
      updatedParent = await Message.findByIdAndUpdate(parentMessageId, {
        $inc: { 'thread.replyCount': 1 },
        $set: { 'thread.lastReplyAt': new Date() },
      }, { new: true }).select('_id thread');
      // Participants feed notifications and avatars; cap the list so a viral thread cannot grow the parent document forever.
      const withParticipant = await Message.findOneAndUpdate(
        { _id: parentMessageId, [`thread.participants.${MAX_THREAD_PARTICIPANTS - 1}`]: { $exists: false } },
        { $addToSet: { 'thread.participants': req.userId } }, { new: true },
      ).select('_id thread');
      if (withParticipant) updatedParent = withParticipant;
    }

    // Update channel last activity OR DM lastMessage/lastActivity
    if (channelId) {
      await Channel.findByIdAndUpdate(channelId, {
        lastActivity: new Date(),
        $inc: { messageCount: 1 },
      });
    } else if (dmId) {
      await DirectMessage.findByIdAndUpdate(dmId, {
        lastMessage: message._id,
        lastActivity: new Date(),
      });
    }

    populatedMessage = await Message.findById(message._id)
      .populate('sender', 'displayName avatar username status')
      .populate('thread.participants', 'displayName avatar username status');

    const notificationsToCreate = [];

    // Notifications for @mentions
    if (messageData.mentions && messageData.mentions.length > 0) {
      messageData.mentions
        .filter(uid => uid.toString() !== req.userId)
        .forEach(uid => {
          notificationsToCreate.push({
            recipient: uid,
            workspace: workspaceId,
            type: 'mention',
            actor: req.userId,
            message: message._id,
            channel: channelId || undefined,
            dm: dmId || undefined,
            content: normalizedContent.substring(0, 100),
            metadata: { preview: normalizedContent.substring(0, 160) },
          });
        });
    }

    // Notify DM participants who are not actively viewing this DM. Thread replies use
    // the thread notification below so one event does not create two activity rows.
    if (dmId && !parentMessageId) {
      const dm = await DirectMessage.findById(dmId).select('participants isGroup');
      if (dm) {
        const recipients = dm.participants
          .map(p => p.toString())
          .filter(p => p !== req.userId);
        recipients.forEach(uid => {
          notificationsToCreate.push({
            recipient: uid,
            workspace: workspaceId,
            type: 'direct_message',
            actor: req.userId,
            message: message._id,
            dm: dmId,
            content: normalizedContent.substring(0, 100),
            metadata: { preview: normalizedContent.substring(0, 160) },
          });
        });
      }
    }

    // Notification for thread reply — notify parent sender + participants
    if (parentMessageId) {
      const parentMsg = await Message.findById(parentMessageId).select('sender thread workspace');
      if (parentMsg) {
        const notifySet = new Set([
          parentMsg.sender.toString(),
          ...(parentMsg.thread.participants || []).map(p => p.toString()),
        ]);
        notifySet.delete(req.userId);
        // A mention in a thread is one activity item, not two.
        (messageData.mentions || []).forEach(id => notifySet.delete(String(id)));
        notifySet.forEach(uid => {
          notificationsToCreate.push({
            recipient: uid,
            workspace: workspaceId,
            type: 'thread_reply',
            actor: req.userId,
            message: message._id,
            channel: channelId || undefined,
            dm: dmId || undefined,
            threadParent: parentMessageId,
            content: normalizedContent.substring(0, 100),
            metadata: { preview: normalizedContent.substring(0, 160) },
          });
        });
      }
    }

    // Root channel posts can notify members whose workspace preference is "all".
    // Mention recipients are excluded to avoid duplicate activity for one post.
    if (channelId && !parentMessageId) {
      const channel = await Channel.findById(channelId).select('members');
      const mentioned = new Set((messageData.mentions || []).map((id) => String(id)));
      (channel?.members || []).forEach((member) => {
        const recipient = String(member.user);
        if (recipient === String(req.userId) || mentioned.has(recipient)) return;
        notificationsToCreate.push({
          recipient,
          workspace: workspaceId,
          type: 'channel_message',
          actor: req.userId,
          message: message._id,
          channel: channelId,
          content: normalizedContent.substring(0, 100),
          metadata: { preview: normalizedContent.substring(0, 160) },
          dedupeKey: `channel_message:${message._id}:${recipient}`,
        });
      });
    }

    const insertedNotifications = await createNotifications(req.app.get('io'), notificationsToCreate);

    // Emit via socket
    const io = req.app.get('io');
    const room = channelId ? `channel:${channelId}` : `dm:${dmId}`;
    
    // Message content goes only to the conversation room; never to the workspace room.
    const socketMessage = stripAttachmentLinks(populatedMessage);
    io.to(room).emit('message:new', socketMessage);

    if (parentMessageId) {
      io.to(`thread:${parentMessageId}`).emit('thread:new', socketMessage);
      io.to(`thread:${parentMessageId}`).emit('message:new_reply', socketMessage);
      if (updatedParent) {
        io.to(room).emit('message:thread_updated', {
          messageId: updatedParent._id,
          replyCount: updatedParent.thread.replyCount,
          lastReplyAt: updatedParent.thread.lastReplyAt,
          participants: updatedParent.thread.participants,
        });
      }
    }

    } catch (sideEffectError) {
      console.error('Post-send processing failed (message was stored):', sideEffectError.message);
    }
    if (!populatedMessage) populatedMessage = await Message.findById(message._id).populate('sender', 'displayName avatar username status').catch(() => message);
    res.status(201).json({ message: populatedMessage, parent: updatedParent });
  } catch (err) {
    if (!messageCreated && stagedAttachments.length) {
      await Promise.allSettled(stagedAttachments.map((attachment) => destroyAsset(
        attachment.publicId,
        attachment.resourceType,
        attachment.accessMode === 'authenticated' ? 'authenticated' : 'upload',
      )));
      await StoredAttachment.updateMany(
        { _id: { $in: stagedAttachments.map((attachment) => attachment._id) }, status: 'staged' },
        { $set: { status: 'deleted' } },
      ).catch(() => undefined);
    }
    // Never log the error object itself: Mongoose validation errors embed the offending field values (message text).
    if (err.name === 'ValidationError') return res.status(400).json({ error: 'Message is invalid' });
    if (!err.status) console.error('Send message failed:', String(err.message).slice(0, 200));
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to send message' });
  }
});

// POST /api/messages/:messageId/forward - create an attributed copy in another conversation.
router.post('/:messageId/forward', authenticate, [
  body('channelId').optional().isMongoId(),
  body('dmId').optional().isMongoId(),
], async (req, res) => {
  try {
    const validation = validationResult(req);
    if (!validation.isEmpty()) return res.status(400).json({ error: 'Invalid destination' });
    const { channelId, dmId } = req.body;
    if (Boolean(channelId) === Boolean(dmId)) return res.status(400).json({ error: 'Provide exactly one channelId or dmId' });

    const sourceAccess = await getMessageContext(req.params.messageId, req.userId);
    if (sourceAccess.error) return res.status(sourceAccess.status).json({ error: sourceAccess.error });
    const source = sourceAccess.message;
    const workspaceId = sourceAccess.workspace._id;

    let targetChannel = null;
    let targetDM = null;
    if (channelId) {
      const targetAccess = await getChannelContext(channelId, req.userId, { requireMembership: true, writable: true });
      if (targetAccess.error) return res.status(targetAccess.status).json({ error: targetAccess.error });
      if (String(targetAccess.workspace._id) !== String(workspaceId)) return res.status(403).json({ error: 'Forwarding is limited to conversations in the same workspace' });
      targetChannel = targetAccess.channel;
    } else {
      const targetAccess = await getDMContext(dmId, req.userId);
      if (targetAccess.error) return res.status(targetAccess.status).json({ error: targetAccess.error });
      if (String(targetAccess.workspace._id) !== String(workspaceId)) return res.status(403).json({ error: 'Forwarding is limited to conversations in the same workspace' });
      targetDM = targetAccess.dm;
    }

    if ((source.attachments || []).some((attachment) => attachment.type !== 'link' && !attachment.uploadId)) {
      return res.status(409).json({ error: 'An attachment in this message cannot be safely forwarded' });
    }
    const attachmentIds = (source.attachments || []).map((attachment) => attachment.uploadId).filter(Boolean);
    if (attachmentIds.length) {
      const stored = await StoredAttachment.find({ _id: { $in: attachmentIds }, workspace: workspaceId, status: 'attached' }).select('_id');
      if (stored.length !== new Set(attachmentIds.map(String)).size) return res.status(409).json({ error: 'One or more attachments are no longer available to forward' });
    }

    const senderId = source.sender?._id || source.sender;
    const sender = await User.findById(senderId).select('displayName');
    const sourceConversation = source.channel
      ? `#${String(sourceAccess.channel?.name || '').trim() || 'channel'}`
      : (sourceAccess.dm.isGroup
        ? String(sourceAccess.dm.groupName || '').trim() || 'Group message'
        : 'Direct message');
    const forwardedFrom = source.forwardedFrom?.senderName?.trim() && source.forwardedFrom?.conversationName?.trim()
      ? source.forwardedFrom.toObject?.() || source.forwardedFrom
      : {
        senderName: String(sender?.displayName || '').trim() || 'Unknown sender',
        conversationName: sourceConversation,
        createdAt: source.createdAt,
        isThreadReply: Boolean(source.thread?.parentMessage),
      };
    const normalizedRichContent = normalizeRichContent(source.formattedContent);
    const forwarded = await Message.create({
      workspace: workspaceId,
      ...(targetChannel ? { channel: targetChannel._id } : { dm: targetDM._id }),
      sender: req.userId,
      content: source.content,
      formattedContent: normalizedRichContent ? JSON.stringify(normalizedRichContent) : '',
      attachments: source.attachments || [],
      mentions: [],
      channelMentions: [],
      forwardedFrom,
    });

    if (targetChannel) {
      await Channel.findByIdAndUpdate(targetChannel._id, { lastActivity: new Date(), $inc: { messageCount: 1 } });
    } else {
      await DirectMessage.findByIdAndUpdate(targetDM._id, { lastMessage: forwarded._id, lastActivity: new Date() });
    }

    const populated = await Message.findById(forwarded._id)
      .populate('sender', 'displayName avatar username status')
      .populate('thread.participants', 'displayName avatar username status');
    const io = req.app.get('io');
    const room = targetChannel ? `channel:${targetChannel._id}` : `dm:${targetDM._id}`;
    io.to(room).emit('message:new', stripAttachmentLinks(populated));

    if (targetDM) {
      const notifications = targetDM.participants
        .map((participant) => participant.toString())
        .filter((participant) => participant !== req.userId)
        .map((recipient) => ({
          recipient,
          workspace: workspaceId,
          type: 'direct_message',
          actor: req.userId,
          message: forwarded._id,
          dm: targetDM._id,
          content: source.content.substring(0, 100),
          metadata: { preview: source.content.substring(0, 160), forwarded: true },
        }));
      await createNotifications(io, notifications);
    }

    return res.status(201).json({ message: populated });
  } catch (err) {
    if (!err.status) console.error(describeError(err));
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to forward message' });
  }
});

// PUT /api/messages/:messageId - Edit message
router.put('/:messageId', authenticate, [
  body('content').isString().isLength({ min: 1, max: 40000 }).withMessage('Message must be 1-40,000 characters'),
  body('formattedContent').optional().isString().isLength({ max: MAX_RICH_CONTENT_LENGTH }),
], async (req, res) => {
  try {
    const validation = validationResult(req);
    if (!validation.isEmpty()) return res.status(400).json({ error: validation.array({ onlyFirstError: true })[0].msg });
    const message = await Message.findById(req.params.messageId);
    if (!message || message.isDeleted) return res.status(404).json({ error: 'Message not found' });
    if (message.isSystemMessage) return res.status(403).json({ error: 'System messages cannot be edited' });
    const access = message.channel
      ? await getChannelContext(message.channel, req.userId, { writable: true, light: true })
      : await getDMContext(message.dm, req.userId, { light: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (String(message.workspace) !== String(access.workspace._id)) {
      return res.status(403).json({ error: 'Message workspace does not match channel workspace' });
    }
    if (message.sender.toString() !== req.userId) return res.status(403).json({ error: 'Not your message' });

    const normalizedRichContent = normalizeRichContent(req.body.formattedContent);
    if (req.body.formattedContent && !normalizedRichContent) return res.status(400).json({ error: 'Invalid formatted content' });
    message.content = normalizedRichContent ? richContentToText(normalizedRichContent).trim() : req.body.content.trim();
    message.formattedContent = normalizedRichContent ? JSON.stringify(normalizedRichContent) : '';
    message.mentions = await extractMentions(message.content, message.workspace);
    // Conditional write: a delete that lands between the read above and this save must win.
    const saved = await Message.updateOne({ _id: message._id, isDeleted: false }, { $set: {
      content: message.content, formattedContent: message.formattedContent, mentions: message.mentions, isEdited: true, editedAt: new Date(),
    } });
    if (!saved.matchedCount) return res.status(404).json({ error: 'Message not found' });

    const populated = await Message.findById(message._id)
      .populate('sender', 'displayName avatar username status')
      .populate('thread.participants', 'displayName avatar username status');

    const io = req.app.get('io');
    const room = message.channel ? `channel:${message.channel}` : `dm:${message.dm}`;
    io.to(room).emit('message:updated', stripAttachmentLinks(populated));
    if (message.thread?.parentMessage) io.to(`thread:${message.thread.parentMessage}`).emit('message:updated', stripAttachmentLinks(populated));

    res.json({ message: populated });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: 'Message is invalid' });
    if (!err.status) console.error('Edit message failed:', String(err.message).slice(0, 200));
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to edit message' });
  }
});

// DELETE /api/messages/:messageId
router.delete('/:messageId', authenticate, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Not found' });
    const access = message.channel
      ? await getChannelContext(message.channel, req.userId)
      : await getDMContext(message.dm, req.userId, { light: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (String(message.workspace) !== String(access.workspace._id)) {
      return res.status(403).json({ error: 'Message workspace does not match channel workspace' });
    }

    const isSender = message.sender.toString() === req.userId;

    // Check if requester is a channel admin or workspace owner/admin
    let isAdmin = false;
    if (!isSender && message.channel) {
      const channel = access.channel;
      if (channel) {
        const member = channel.members.find(m => m.user.toString() === req.userId);
        if (member && member.role === 'admin') isAdmin = true;

        if (!isAdmin) {
          const Workspace = require('../models/Workspace');
          const ws = await Workspace.findById(channel.workspace).select('members');
          if (ws && ws.isAdmin(req.userId)) isAdmin = true;
        }
      }
    }

    if (!isSender && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to delete this message' });
    }

    // Atomically claim the deletion. Whoever flips isDeleted performs the side effects, so
    // repeating or racing a delete cannot decrement the thread reply count twice.
    const claimed = await Message.findOneAndUpdate(
      { _id: message._id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), content: '', formattedContent: '', attachments: [], isPinned: false } },
    );
    if (!claimed) return res.json({ success: true });

    // Keep a shared upload alive while any forwarded message still references it.
    if (message.attachments?.length) {
      const uploadIds = message.attachments.map((attachment) => attachment.uploadId).filter(Boolean);
      const stored = uploadIds.length
        ? await StoredAttachment.find({ _id: { $in: uploadIds } })
        : [];
      const otherReferences = uploadIds.length
        ? await Message.find({ _id: { $ne: message._id }, isDeleted: false, 'attachments.uploadId': { $in: uploadIds } }).select('attachments.uploadId')
        : [];
      const stillReferenced = new Set(otherReferences.flatMap((entry) => entry.attachments.map((attachment) => String(attachment.uploadId))));
      const releasable = stored.filter((attachment) => !stillReferenced.has(String(attachment._id)));
      const destroyed = await Promise.allSettled(releasable.map((attachment) => destroyAsset(
        attachment.publicId,
        attachment.resourceType,
        attachment.accessMode === 'authenticated' ? 'authenticated' : 'upload',
      )));
      // Files that could not be removed now stay flagged so the cleanup job retries them.
      const removedIds = releasable.filter((_, index) => destroyed[index].status === 'fulfilled').map((attachment) => attachment._id);
      await Promise.allSettled([
        ...message.attachments
          .filter((attachment) => attachment.publicId && !uploadIds.some((id) => String(id) === String(attachment.uploadId)))
          .map((attachment) => destroyAsset(
            attachment.publicId,
            attachment.type === 'image' ? 'image' : 'raw',
            attachment.accessMode === 'authenticated' ? 'authenticated' : 'upload',
          )),
      ]);
      if (releasable.length) {
        await StoredAttachment.updateMany({ _id: { $in: releasable.map((attachment) => attachment._id) } }, { $set: { status: 'deleted', message: null, assetDeleted: false } });
        if (removedIds.length) await StoredAttachment.updateMany({ _id: { $in: removedIds } }, { $set: { assetDeleted: true } });
      }
    }

    const relatedMessageIds = [message._id];
    if (!message.thread?.parentMessage) {
      const replies = await Message.find({ 'thread.parentMessage': message._id }).select('_id');
      relatedMessageIds.push(...replies.map((reply) => reply._id));
    }
    await Notification.deleteMany({ $or: [
      { message: { $in: relatedMessageIds } },
      { threadParent: { $in: relatedMessageIds } },
    ] });

    let updatedThreadParent = null;
    if (message.thread?.parentMessage) {
      updatedThreadParent = await Message.findOneAndUpdate(
        { _id: message.thread.parentMessage, 'thread.replyCount': { $gt: 0 } },
        { $inc: { 'thread.replyCount': -1 } },
        { new: true }
      ).select('_id thread');
    }

    const io = req.app.get('io');
    const room = message.channel ? `channel:${message.channel}` : `dm:${message.dm}`;
    io.to(room).emit('message:deleted', { messageId: message._id });
    if (message.thread?.parentMessage) {
      io.to(`thread:${message.thread.parentMessage}`).emit('message:deleted', { messageId: message._id });
      if (updatedThreadParent) io.to(room).emit('message:thread_updated', { messageId: updatedThreadParent._id, replyCount: updatedThreadParent.thread.replyCount, lastReplyAt: updatedThreadParent.thread.lastReplyAt, participants: updatedThreadParent.thread.participants });
    }
    if (message.channel) {
      await Channel.updateOne({ _id: message.channel }, { $pull: { pinnedMessages: { message: message._id } } });
      io.to(room).emit('message:pinned', { messageId: message._id, isPinned: false });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

const MAX_REACTION_TYPES = 20;
const MAX_REACTION_USERS = 1000;

// Unicode emoji sequences only (including flags, keycaps, ZWJ and skin-tone modifiers), or :shortcode:.
const EMOJI_PATTERN = /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️⃣]|[0-9#*](?=️?⃣))+|:[a-z0-9_+-]{1,30}:)$/u;
function reactionEmoji(value) {
  if (typeof value !== 'string') return null;
  const emoji = value.trim();
  return emoji.length > 0 && emoji.length <= 32 && EMOJI_PATTERN.test(emoji) ? emoji : null;
}

async function loadReactionTarget(req, res) {
  if (!mongoose.isValidObjectId(req.params.messageId)) { res.status(404).json({ error: 'Message not found' }); return null; }
  const message = await Message.findById(req.params.messageId).select('channel dm workspace sender isDeleted content thread');
  if (!message || message.isDeleted) { res.status(404).json({ error: 'Message not found' }); return null; }
  const access = message.channel
    ? await getChannelContext(message.channel, req.userId, { writable: true, light: true })
    : await getDMContext(message.dm, req.userId, { light: true });
  if (access.error) { res.status(access.status).json({ error: access.error }); return null; }
  return message;
}

async function broadcastReactions(req, message) {
  const fresh = await Message.findById(message._id).select('reactions');
  const payload = { messageId: message._id, reactions: reactionPayload(fresh) };
  const io = req.app.get('io');
  const room = message.channel ? `channel:${message.channel}` : `dm:${message.dm}`;
  io.to(room).emit('message:reaction', payload);
  if (message.thread?.parentMessage) io.to(`thread:${message.thread.parentMessage}`).emit('message:reaction', payload);
  return payload.reactions;
}

// POST /api/messages/:messageId/react
// Every step is a single-document conditional update, so concurrent reactions cannot overwrite each other.
router.post('/:messageId/react', authenticate, async (req, res) => {
  try {
    const emoji = reactionEmoji(req.body.emoji);
    if (!emoji) return res.status(400).json({ error: 'A valid emoji is required' });
    const message = await loadReactionTarget(req, res);
    if (!message) return null;

    // 1. Create the reaction entry if this emoji has none yet (fails harmlessly if another request just did).
    await Message.updateOne(
      { _id: message._id, isDeleted: false, 'reactions.emoji': { $ne: emoji }, [`reactions.${MAX_REACTION_TYPES - 1}`]: { $exists: false } },
      { $push: { reactions: { emoji, users: [], count: 0 } } },
    );
    // 2. Add this user once; the filter makes a repeat a no-op.
    const added = await Message.updateOne(
      { _id: message._id, isDeleted: false, reactions: { $elemMatch: { emoji, users: { $ne: req.userId }, [`users.${MAX_REACTION_USERS - 1}`]: { $exists: false } } } },
      { $push: { 'reactions.$.users': req.userId }, $inc: { 'reactions.$.count': 1 } },
    );
    const exists = await Message.exists({ _id: message._id, 'reactions.emoji': emoji });
    if (!exists) return res.status(409).json({ error: `A message can have at most ${MAX_REACTION_TYPES} different reactions` });

    const reactions = await broadcastReactions(req, message);
    if (added.modifiedCount && message.sender.toString() !== req.userId) {
      await createNotifications(req.app.get('io'), [{
        recipient: message.sender, workspace: message.workspace, type: 'reaction', actor: req.userId, message: message._id,
        content: emoji, metadata: { emoji, preview: message.content?.substring(0, 160) || '' },
      }]).catch((error) => console.error('Reaction notification failed:', error.message));
    }
    res.json({ reactions });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// DELETE /api/messages/:messageId/react (idempotent)
router.delete('/:messageId/react', authenticate, async (req, res) => {
  try {
    const emoji = reactionEmoji(req.body?.emoji);
    if (!emoji) return res.status(400).json({ error: 'A valid emoji is required' });
    const message = await loadReactionTarget(req, res);
    if (!message) return null;

    await Message.updateOne(
      { _id: message._id, reactions: { $elemMatch: { emoji, users: req.userId } } },
      { $pull: { 'reactions.$.users': req.userId }, $inc: { 'reactions.$.count': -1 } },
    );
    await Message.updateOne({ _id: message._id }, { $pull: { reactions: { emoji, users: { $size: 0 } } } });
    res.json({ reactions: await broadcastReactions(req, message) });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

async function updatePin(req, res, desiredState) {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message || message.isDeleted) return res.status(404).json({ error: 'Message not found' });
    if (!message.channel) return res.status(403).json({ error: 'Only channel messages can be pinned in this flow' });
    const access = await getChannelContext(message.channel, req.userId, { requireMembership: true, writable: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const isChannelAdmin = access.channel.members.some((member) => (
      member.user.toString() === req.userId && member.role === 'admin'
    ));
    if (!isChannelAdmin && !access.workspace.isAdmin(req.userId)) {
      return res.status(403).json({ error: 'Admin required' });
    }

    const currentlyPinned = access.channel.pinnedMessages.some((entry) => String(entry.message) === String(message._id));
    const nextState = desiredState === null ? !currentlyPinned : desiredState;
    message.isPinned = nextState;
    await message.save();

    const channelUpdate = nextState
      ? { $addToSet: { pinnedMessages: { message: message._id, pinnedBy: req.userId, pinnedAt: new Date() } } }
      : { $pull: { pinnedMessages: { message: message._id } } };
    await Channel.findByIdAndUpdate(message.channel, channelUpdate);

    const io = req.app.get('io');
    const room = `channel:${message.channel}`;
    io.to(room).emit('message:pinned', { messageId: message._id, isPinned: nextState });

    res.json({ isPinned: nextState });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to pin message' });
  }
}

// POST toggles for backward compatibility with the existing client.
router.post('/:messageId/pin', authenticate, (req, res) => updatePin(req, res, null));
router.delete('/:messageId/pin', authenticate, (req, res) => updatePin(req, res, false));

module.exports = router;
