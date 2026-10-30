const mongoose = require('mongoose');

async function getUnreadCounts(Message, conversations, contextField, userId) {
  const eligible = conversations
    .filter((conversation) => conversation.lastRead)
    .map((conversation) => ({ id: conversation.id, lastRead: conversation.lastRead }));
  if (!eligible.length) return new Map();

  const userObjectId = new mongoose.Types.ObjectId(userId);
  const counts = await Message.aggregate([
    {
      $match: {
        isDeleted: false,
        // Thread replies surface through thread notifications, not channel/DM unread badges.
        'thread.parentMessage': null,
        sender: { $ne: userObjectId },
        $or: eligible.map(({ id, lastRead }) => ({
          [contextField]: new mongoose.Types.ObjectId(id),
          createdAt: { $gt: lastRead },
        })),
      },
    },
    {
      $project: {
        conversationId: `$${contextField}`,
        isMention: { $in: [userObjectId, '$mentions'] },
      },
    },
    {
      $group: {
        _id: '$conversationId',
        unreadCount: { $sum: 1 },
        mentionCount: { $sum: { $cond: ['$isMention', 1, 0] } },
      },
    },
  ]);

  return new Map(counts.map((entry) => [String(entry._id), entry]));
}

module.exports = { getUnreadCounts };
