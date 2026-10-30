const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const Message = require('../models/Message');
const User = require('../models/User');
const { isSuperAdmin } = require('../services/adminSecurity');

const ALLOWED_REGISTRATION_DOMAIN = (
  process.env.ALLOWED_REGISTRATION_DOMAIN || ''
).trim().toLowerCase();

const DEFAULT_WORKSPACE_NAME = process.env.DEFAULT_WORKSPACE_NAME || 'Univisionz';
const DEFAULT_WORKSPACE_SLUG = process.env.DEFAULT_WORKSPACE_SLUG || 'univisionz';
const DEFAULT_WORKSPACE_DESCRIPTION = process.env.DEFAULT_WORKSPACE_DESCRIPTION
  || 'Default workspace for the Univisionz team.';

const DEFAULT_CHANNELS = [
  {
    name: 'general',
    description: 'Company-wide announcements and work-based matters',
  },
  {
    name: 'random',
    description: 'A place for non-work banter',
  },
];

function isAllowedRegistrationEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  return !ALLOWED_REGISTRATION_DOMAIN || normalizedEmail.endsWith(`@${ALLOWED_REGISTRATION_DOMAIN}`);
}

function getChannelMemberRole(member) {
  return ['owner', 'admin'].includes(member.role) ? 'admin' : 'member';
}

async function getOrCreateDefaultWorkspace(userId) {
  let workspace = await Workspace.findOne({ slug: DEFAULT_WORKSPACE_SLUG });
  let created = false;

  if (workspace?.deletedAt) return { workspace: null, created: false };
  if (!workspace) {
    const user = await User.findById(userId).select('email role accountStatus');
    if (!isSuperAdmin(user)) return { workspace: null, created: false };
  }

  if (!workspace) {
    try {
      workspace = await Workspace.create({
        name: DEFAULT_WORKSPACE_NAME,
        slug: DEFAULT_WORKSPACE_SLUG,
        description: DEFAULT_WORKSPACE_DESCRIPTION,
        owner: userId,
        members: [{ user: userId, role: 'owner' }],
      });
      created = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      workspace = await Workspace.findOne({ slug: DEFAULT_WORKSPACE_SLUG });
      if (!workspace) throw err;
    }
  }

  return { workspace, created };
}

async function ensureDefaultChannels(workspace) {
  const channelNames = DEFAULT_CHANNELS.map(channel => channel.name);
  const channelMembers = workspace.members.map(member => ({
    user: member.user,
    role: getChannelMemberRole(member),
  }));

  const existingChannels = await Channel.find({
    workspace: workspace._id,
    name: { $in: channelNames },
  });

  const channelsByName = new Map(existingChannels.map(channel => [channel.name, channel]));

  for (const definition of DEFAULT_CHANNELS) {
    let channel = channelsByName.get(definition.name);

    if (!channel) {
      channel = await Channel.create({
        workspace: workspace._id,
        name: definition.name,
        description: definition.description,
        type: 'public',
        createdBy: workspace.owner,
        isDefault: true,
        members: channelMembers,
      });

      if (definition.name === 'general') {
        await Message.create({
          workspace: workspace._id,
          channel: channel._id,
          sender: workspace.owner,
          content: `Welcome to ${workspace.name}!`,
          isSystemMessage: true,
          systemMessageType: 'workspace_created',
        });
      }

      continue;
    }

    let changed = false;

    if (!channel.isDefault) {
      channel.isDefault = true;
      changed = true;
    }

    for (const member of channelMembers) {
      if (!channel.isMember(member.user)) {
        channel.members.push(member);
        changed = true;
      }
    }

    if (changed) {
      await channel.save();
    }
  }
}

async function ensureDefaultWorkspaceMembership(userId) {
  // Open registration must never grant access to an existing team's conversations.
  if (process.env.AUTO_JOIN_DEFAULT_WORKSPACE !== 'true' || !ALLOWED_REGISTRATION_DOMAIN) return null;
  const joiningUser = await User.findById(userId).select('email role accountStatus');
  if (!joiningUser || joiningUser.accountStatus === 'disabled' || (!isSuperAdmin(joiningUser) && !isAllowedRegistrationEmail(joiningUser.email))) return null;
  const { workspace } = await getOrCreateDefaultWorkspace(userId);
  if (!workspace) return null;
  // A shared email domain never substitutes for workspace administrator approval.
  if (!workspace.isMember(userId) && String(workspace.owner) !== String(userId)) return null;
  let changed = false;

  if (!workspace.isMember(workspace.owner)) {
    workspace.members.push({ user: workspace.owner, role: 'owner' });
    changed = true;
  }

  if (!workspace.isMember(userId)) {
    workspace.members.push({
      user: userId,
      role: workspace.owner.toString() === userId.toString() ? 'owner' : 'member',
    });
    changed = true;
  }

  if (changed) {
    await workspace.save();
  }

  await User.findByIdAndUpdate(userId, { $addToSet: { workspaces: workspace._id } });
  // Only synchronize the current member; do not scan every user on every request.
  await ensureDefaultChannels(workspace);

  return workspace;
}

module.exports = {
  ALLOWED_REGISTRATION_DOMAIN,
  DEFAULT_WORKSPACE_NAME,
  isAllowedRegistrationEmail,
  ensureDefaultWorkspaceMembership,
};
