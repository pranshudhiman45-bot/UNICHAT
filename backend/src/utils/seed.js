require('dotenv').config();
const { assertSeedAllowed } = require('./seedGuard');
const mongoose = require('mongoose');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const DirectMessage = require('../models/DirectMessage');
const Notification = require('../models/Notification');
const StarredMessage = require('../models/StarredMessage');

const seed = async () => {
  assertSeedAllowed(); // throws before any connection or deletion
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  // Clear existing data
  await Promise.all([
    User.deleteMany(),
    Workspace.deleteMany(),
    Channel.deleteMany(),
    Message.deleteMany(),
    DirectMessage.deleteMany(),
    Notification.deleteMany(),
    StarredMessage.deleteMany(),
  ]);
  console.log('Cleared existing data');

  // Create users
  const users = await User.create([
    { username: 'alexrivera', email: 'alex@unichat.com', password: 'password123', displayName: 'Alex Rivera', status: 'online', title: 'Lead Design Architect', bio: 'Designing systems that scale.' },
    { username: 'sarahchen', email: 'sarah@unichat.com', password: 'password123', displayName: 'Sarah Chen', status: 'online', title: 'Product Manager', bio: 'Building things people love.' },
    { username: 'jordantaylor', email: 'jordan@unichat.com', password: 'password123', displayName: 'Jordan Taylor', status: 'away', title: 'Senior Engineer' },
    { username: 'marcusthorne', email: 'marcus@unichat.com', password: 'password123', displayName: 'Marcus Thorne', status: 'busy', title: 'Backend Developer' },
  ]);

  console.log(`Created ${users.length} users`);

  const [alex, sarah, jordan, marcus] = users;

  // Create workspace
  const workspace = await Workspace.create({
    name: 'Indigo Nexus',
    slug: 'indigo-nexus',
    description: 'The Unichat design collective workspace.',
    owner: alex._id,
    members: users.map((u, i) => ({ user: u._id, role: i === 0 ? 'owner' : 'member' })),
  });
  console.log('Created workspace:', workspace.name);

  // Update users with workspace
  await User.updateMany({ _id: { $in: users.map(u => u._id) } }, { $addToSet: { workspaces: workspace._id } });

  // Create channels
  const membersList = users.map(u => ({ user: u._id, role: 'member' }));
  const channels = await Channel.insertMany([
    { workspace: workspace._id, name: 'general', description: 'Company-wide updates', type: 'public', isDefault: true, createdBy: alex._id, members: membersList },
    { workspace: workspace._id, name: 'engineering', description: 'Tech stack & sprint logs', type: 'public', createdBy: alex._id, members: membersList },
    { workspace: workspace._id, name: 'design-systems', description: 'Token updates & audits', type: 'public', createdBy: alex._id, members: membersList },
    { workspace: workspace._id, name: 'marketing', description: 'Campaign brainstorms', type: 'public', createdBy: sarah._id, members: membersList },
    { workspace: workspace._id, name: 'random', description: 'Non-work banter', type: 'public', isDefault: true, createdBy: alex._id, members: membersList },
    { workspace: workspace._id, name: 'leadership', description: 'Private leadership channel', type: 'private', createdBy: alex._id, members: [{ user: alex._id, role: 'admin' }, { user: sarah._id, role: 'member' }] },
  ]);
  console.log(`Created ${channels.length} channels`);

  const [general, engineering, designSystems] = channels;

  // Seed messages
  const msgs = await Message.insertMany([
    { workspace: workspace._id, channel: general._id, sender: alex._id, content: 'Welcome to Indigo Nexus! 🎉 This is our new workspace built on Unichat.', isSystemMessage: false },
    { workspace: workspace._id, channel: general._id, sender: sarah._id, content: 'So excited to be here! The new design system looks incredible.' },
    { workspace: workspace._id, channel: general._id, sender: jordan._id, content: 'Hey everyone! @alexrivera the micro-frontend architecture proposal is ready for review.' },
    { workspace: workspace._id, channel: general._id, sender: alex._id, content: 'Will review it today. Can you share the link in #engineering?' },
    { workspace: workspace._id, channel: engineering._id, sender: jordan._id, content: "I've finalized the architectural proposal for the micro-frontend migration. Can someone from @sarahchen take a look?" },
    { workspace: workspace._id, channel: engineering._id, sender: sarah._id, content: 'Looking at it now! The boundaries look clean. Great work @jordantaylor 🚀', mentions: [jordan._id] },
    { workspace: workspace._id, channel: engineering._id, sender: marcus._id, content: 'The API endpoints are all documented. We should be good for the sprint demo.' },
    { workspace: workspace._id, channel: designSystems._id, sender: sarah._id, content: 'New token updates are live! Please review the spacing changes in the design file.' },
    { workspace: workspace._id, channel: designSystems._id, sender: alex._id, content: 'The Electric Aubergine palette really makes the components pop. It feels premium! 💜' },
  ]);

  // Add reactions to some messages
  await Message.findByIdAndUpdate(msgs[4]._id, {
    reactions: [
      { emoji: '🚀', users: [alex._id, sarah._id], count: 2 },
      { emoji: '👀', users: [marcus._id], count: 1 },
    ],
  });

  // Add thread to a message
  const parentMsg = msgs[4];
  const reply1 = await Message.create({
    workspace: workspace._id,
    channel: engineering._id,
    sender: sarah._id,
    content: 'The component boundaries look great. I like how we separated the auth module.',
    thread: { parentMessage: parentMsg._id },
  });
  const reply2 = await Message.create({
    workspace: workspace._id,
    channel: engineering._id,
    sender: marcus._id,
    content: 'Agreed. Are we sticking with 0.75rem radius for all primary cards?',
    thread: { parentMessage: parentMsg._id },
  });
  await Message.findByIdAndUpdate(parentMsg._id, {
    'thread.replyCount': 2,
    'thread.lastReplyAt': new Date(),
    'thread.participants': [sarah._id, marcus._id],
  });

  console.log(`Created ${msgs.length + 2} messages`);
  console.log('\n✅ Seed complete!');
  console.log('\n👥 Test accounts:');
  users.forEach(u => console.log(`  - ${u.email} / password123`));
  console.log('\n🏢 Workspace invite code:', workspace.inviteCode);
  await mongoose.disconnect();
};

seed().catch(err => { console.error(err); process.exit(1); });
