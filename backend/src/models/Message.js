const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema({
  emoji: { type: String, required: true },
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  count: { type: Number, default: 0 },
}, { _id: false });

const attachmentSchema = new mongoose.Schema({
  uploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoredAttachment' },
  type: { type: String, enum: ['image', 'video', 'audio', 'document', 'link'], required: true },
  url: { type: String, required: true },
  secureUrl: { type: String },
  publicId: { type: String },
  name: { type: String },
  size: { type: Number },
  mimeType: { type: String },
  width: { type: Number },
  height: { type: Number },
  thumbnail: { type: String },
  duration: { type: Number },
  format: { type: String },
  resourceType: { type: String },
  accessMode: { type: String, enum: ['public', 'authenticated'] },
}, { _id: true });

const forwardedFromSchema = new mongoose.Schema({
  senderName: { type: String, maxlength: 120 },
  conversationName: { type: String, maxlength: 160 },
  createdAt: { type: Date },
  isThreadReply: { type: Boolean, default: false },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', index: true },
  dm: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectMessage', index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, default: '', maxlength: 40000 },
  formattedContent: { type: String, default: '' },
  forwardedFrom: { type: forwardedFromSchema, default: undefined },
  attachments: [attachmentSchema],
  reactions: [reactionSchema],
  thread: {
    parentMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    replyCount: { type: Number, default: 0 },
    lastReplyAt: { type: Date },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  channelMentions: [{ type: String }],
  isEdited: { type: Boolean, default: false },
  editedAt: { type: Date },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  isPinned: { type: Boolean, default: false },
  // Client-generated idempotency key: retrying a send with the same key returns the original message.
  clientMessageId: { type: String, maxlength: 64 },
  isSystemMessage: { type: Boolean, default: false },
  systemMessageType: { type: String },
}, { timestamps: true });

messageSchema.index({ channel: 1, createdAt: -1 });
messageSchema.index({ dm: 1, createdAt: -1 });
// History paging filters out thread replies (thread.parentMessage = null) and sorts by (createdAt, _id): the
// equality field in the index lets Mongo walk exactly the page it needs instead of skipping over replies.
messageSchema.index({ channel: 1, 'thread.parentMessage': 1, createdAt: -1, _id: -1 });
messageSchema.index({ dm: 1, 'thread.parentMessage': 1, createdAt: -1, _id: -1 });
messageSchema.index({ sender: 1, clientMessageId: 1 }, { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } });
messageSchema.index({ channel: 1, updatedAt: 1 });
messageSchema.index({ dm: 1, updatedAt: 1 });
messageSchema.index({ workspace: 1, createdAt: -1 });
messageSchema.index({ workspace: 1, content: 'text', 'attachments.name': 'text' });
messageSchema.index({ workspace: 1, sender: 1, createdAt: -1 });
messageSchema.index({ 'thread.parentMessage': 1 });
messageSchema.index({ 'thread.parentMessage': 1, createdAt: 1 });
messageSchema.index({ workspace: 1, mentions: 1, createdAt: -1 });

messageSchema.pre('validate', function (next) {
  const contextCount = Number(Boolean(this.channel)) + Number(Boolean(this.dm));
  if (contextCount !== 1) return next(new Error('A message must belong to exactly one channel or conversation'));
  next();
});

module.exports = mongoose.model('Message', messageSchema);
