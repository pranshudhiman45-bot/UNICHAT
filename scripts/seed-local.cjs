const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('../backend/node_modules/dotenv').config({ path: path.join(root, 'backend/.env.test.local') });
const mongoose = require('../backend/node_modules/mongoose');
const User = require('../backend/src/models/User');
const Workspace = require('../backend/src/models/Workspace');
const Channel = require('../backend/src/models/Channel');
const Message = require('../backend/src/models/Message');
async function seed() {
  if (process.env.MONGODB_URI !== 'mongodb://127.0.0.1:27017/unichat_local_test') throw new Error('Refusing to seed anything except the dedicated local test database');
  const accounts = JSON.parse(fs.readFileSync(path.join(root, '.local/test-accounts.json'), 'utf8'));
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const users = [];
  for (const [name, account] of Object.entries(accounts)) {
    if (name === 'admin') continue;
    let user = await User.findOne({ email: account.email });
    if (!user) user = await User.create({ ...account, username: `demo_${name}`, displayName: name === 'alex' ? 'Alex Morgan' : 'Maya Chen', title: name === 'alex' ? 'Product Designer' : 'Frontend Engineer', emailVerifiedAt: new Date() });
    users.push(user);
  }
  let workspace = await Workspace.findOne({ slug: 'local-demo-studio' });
  if (!workspace) {
    workspace = await Workspace.create({ name: 'Northstar Studio', slug: 'local-demo-studio', description: 'A demo space for good ideas and the people behind them.', owner: users[0]._id, members: users.map((user, index) => ({ user: user._id, role: index ? 'member' : 'owner' })) });
    for (const name of ['general', 'design', 'engineering', 'random']) {
      const channel = await Channel.create({ workspace: workspace._id, name, description: name === 'general' ? 'Team updates, small wins, and what’s next.' : `All things ${name}`, createdBy: users[0]._id, type: 'public', isDefault: name === 'general' || name === 'random', members: users.map((user, index) => ({ user: user._id, role: index ? 'member' : 'admin' })) });
      if (name === 'general') for (const [index, content] of ['Welcome to Northstar Studio! This is our shared space for team updates and good conversations.', 'Morning team! The first design review is ready. I’d love your thoughts on the new onboarding flow.', 'Love how this is coming together. I’ll take a look after standup.', 'A small win for today: our new workspace is up and running. Try a thread, add a reaction, or invite a teammate.'].entries()) await Message.create({ workspace: workspace._id, channel: channel._id, sender: users[index % 2]._id, content });
    }
    await User.updateMany({ _id: { $in: users.map((user) => user._id) } }, { $addToSet: { workspaces: workspace._id } });
  }
  console.log('Demo workspace ready. Credentials are in .local/test-accounts.json. Existing data was preserved.');
}
seed().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
