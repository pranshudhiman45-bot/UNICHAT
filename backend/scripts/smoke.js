const assert = require('node:assert/strict');

const API = process.env.SMOKE_API_URL || 'http://localhost:4000/api';
const SOCKET_URL = process.env.SMOKE_SOCKET_URL || 'http://localhost:4000';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function multipartRequest(path, { token, fields = {}, files = [], fileField = 'files' } = {}) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
  files.forEach((file) => form.append(fileField, new Blob([file.body], { type: file.type }), file.name));
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: expected ${status}, got ${result.status} (${JSON.stringify(result.data)})`);
}

async function login(email, password = 'password123') {
  const result = await request('/auth/login', { method: 'POST', body: { email, password } });
  expectStatus(result, 200, `login ${email}`);
  return result.data;
}

async function run() {
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const tinyMp4 = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const outsiderEmail = `smoke${suffix}@univisionz.com`;
  const outsider = await request('/auth/register', {
    method: 'POST',
    body: { username: `smoke${suffix}`, email: outsiderEmail, password: 'password123', displayName: 'Smoke Outsider' },
  });
  expectStatus(outsider, 201, 'register outsider');

  const alex = await login('alex@unichat.com');
  const priya = await login('sarah@unichat.com');
  const workspaceMember = await login('jordan@unichat.com');
  const groupMember = await login('marcus@unichat.com');
  const outsiderToken = outsider.data.accessToken;
  expectStatus(await request('/users/profile', { method: 'PUT', body: { displayName: 'No auth' } }), 401, 'profile edit requires authentication');
  const profileUpdate = await request('/users/profile', { method: 'PUT', token: outsiderToken, body: {
    displayName: 'Smoke Profile', title: 'QA', bio: 'Testing profile edits', statusMessage: 'Available', timezone: 'Asia/Kolkata',
  } });
  expectStatus(profileUpdate, 200, 'profile text update');
  assert.equal(profileUpdate.data.user.displayName, 'Smoke Profile');
  assert.equal(profileUpdate.data.user.timezone, 'Asia/Kolkata');
  const profileRead = await request(`/users/profile/${outsider.data.user._id}`, { token: outsiderToken });
  expectStatus(profileRead, 200, 'read updated profile');
  assert.equal(profileRead.data.user.bio, 'Testing profile edits');
  const profileStatus = await request('/users/profile', { method: 'PUT', token: outsiderToken, body: { status: 'away' } });
  expectStatus(profileStatus, 200, 'mobile profile status update');
  assert.equal(profileStatus.data.user.status, 'away');
  expectStatus(await request('/users/profile', { method: 'PUT', token: outsiderToken, body: { displayName: ' ' } }), 400, 'reject blank display name');
  expectStatus(await request('/users/profile', { method: 'PUT', token: outsiderToken, body: { timezone: 'Not/A_Real_Timezone' } }), 400, 'reject invalid timezone');
  expectStatus(await request('/users/profile', { method: 'PUT', token: outsiderToken, body: { avatar: 'https://example.com/unsafe.svg' } }), 400, 'reject arbitrary avatar URL');
  expectStatus(await request('/users/profile', { method: 'PUT', token: outsiderToken, body: { avatarPublicId: 'someone-elses-photo' } }), 400, 'reject arbitrary avatar asset ID');
  expectStatus(await multipartRequest('/users/avatar', { token: outsiderToken, fileField: 'avatar', files: [{ name: 'fake.png', type: 'image/png', body: Buffer.from('not an image') }] }), 400, 'reject invalid avatar signature');
  expectStatus(await multipartRequest('/users/avatar', { token: outsiderToken, fileField: 'avatar', files: [{ name: 'fake.svg', type: 'image/svg+xml', body: Buffer.from('<svg/>') }] }), 400, 'reject unsupported avatar type');
  expectStatus(await request('/users/avatar', { method: 'DELETE', token: outsiderToken }), 200, 'remove profile photo');
  expectStatus(await request('/auth/me', { token: alex.accessToken }), 200, 'me');
  expectStatus(await request('/users/web-push/config'), 401, 'browser push config requires authentication');
  const browserConfig = await request('/users/web-push/config', { token: priya.accessToken });
  expectStatus(browserConfig, 200, 'browser push config');
  assert.ok(Object.hasOwn(browserConfig.data, 'publicKey'), 'browser push config should report server capability');
  const browserSettings = await request('/users/notification-settings', {
    method: 'PUT', token: priya.accessToken, body: { webPushEnabled: true, sounds: false, pushPreview: false },
  });
  expectStatus(browserSettings, 200, 'enable browser notification settings');
  assert.equal(browserSettings.data.notificationSettings.webPushEnabled, true);
  expectStatus(await request('/users/web-push/subscriptions', {
    method: 'POST', token: priya.accessToken, body: { endpoint: 'http://localhost/private', keys: { p256dh: 'x', auth: 'x' } },
  }), browserConfig.data.publicKey ? 400 : 503, 'reject invalid browser push subscription');
  if (browserConfig.data.publicKey) {
    const browserEndpoint = `https://fcm.googleapis.com/fcm/send/${suffix}`;
    expectStatus(await request('/users/web-push/subscriptions', {
      method: 'POST', token: priya.accessToken, body: { endpoint: browserEndpoint, keys: { p256dh: 'p256dh-test', auth: 'auth-test' }, userAgent: 'smoke-test' },
    }), 200, 'register browser push subscription');
    expectStatus(await request('/users/web-push/subscriptions', {
      method: 'POST', token: outsiderToken, body: { endpoint: browserEndpoint, keys: { p256dh: 'other', auth: 'other' } },
    }), 409, 'prevent browser push subscription reassignment');
    expectStatus(await request('/users/web-push/subscriptions', {
      method: 'DELETE', token: priya.accessToken, body: { endpoint: browserEndpoint },
    }), 200, 'remove browser push subscription');
  }
  expectStatus(await request('/users/notification-settings', {
    method: 'PUT', token: priya.accessToken, body: { webPushEnabled: false, sounds: true, pushPreview: true },
  }), 200, 'reset browser notification settings');

  if (!process.env.SMOKE_ADMIN_EMAIL || !process.env.SMOKE_ADMIN_PASSWORD) throw new Error('SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD are required for workspace creation checks');
  const admin = await login(process.env.SMOKE_ADMIN_EMAIL, process.env.SMOKE_ADMIN_PASSWORD);
  expectStatus(await request('/workspaces', { method: 'POST', token: alex.accessToken, body: { name: 'Denied Workspace' } }), 403, 'normal user cannot create workspace');
  const workspaceResult = await request('/workspaces', {
    method: 'POST',
    token: admin.accessToken,
    body: { name: `Smoke Workspace ${suffix}`, slug: `smoke-${suffix}`, description: 'Automated smoke workspace' },
  });
  expectStatus(workspaceResult, 201, 'create workspace');
  const workspace = workspaceResult.data.workspace;
  const invite = workspace.inviteCode;

  for (const member of [alex, priya, workspaceMember, groupMember]) {
    const submission = await request(`/workspaces/join/${invite}`, { method: 'POST', token: member.accessToken });
    expectStatus(submission, 202, 'workspace join request');
    expectStatus(await request(`/workspaces/${workspace._id}/join-requests/${submission.data.request._id}/approve`, { method: 'POST', token: admin.accessToken }), 200, 'administrator approves membership');
  }

  const publicResult = await request('/channels', {
    method: 'POST',
    token: alex.accessToken,
    body: { workspaceId: workspace._id, name: 'smoke-public', type: 'public' },
  });
  expectStatus(publicResult, 201, 'create public channel');
  const publicChannel = publicResult.data.channel;

  const privateResult = await request('/channels', {
    method: 'POST',
    token: alex.accessToken,
    body: { workspaceId: workspace._id, name: 'smoke-private', type: 'private', memberIds: [priya.user._id] },
  });
  expectStatus(privateResult, 201, 'create private channel');
  const privateChannel = privateResult.data.channel;

  const directResult = await request('/dms', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, participantIds: [priya.user._id] },
  });
  expectStatus(directResult, 201, 'create one-to-one DM');
  const directMessage = directResult.data.dm;
  const duplicateDirect = await request('/dms', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, participantIds: [priya.user._id] },
  });
  expectStatus(duplicateDirect, 200, 'prevent duplicate one-to-one DM');
  assert.equal(duplicateDirect.data.dm._id, directMessage._id);

  const groupResult = await request('/dms', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, participantIds: [priya.user._id, groupMember.user._id], isGroup: true },
  });
  expectStatus(groupResult, 201, 'create group DM');
  const groupMessage = groupResult.data.dm;
  expectStatus(await request(`/dms?workspaceId=${workspace._id}`, { token: outsiderToken }), 403, 'outsider DM list');
  expectStatus(await request(`/dms/${directMessage._id}/messages`, { token: workspaceMember.accessToken }), 403, 'unauthorized DM history');

  const dmMessageResult = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, dmId: directMessage._id, content: 'Hello from the DM' },
  });
  expectStatus(dmMessageResult, 201, 'send DM message');
  const dmMessageId = dmMessageResult.data.message._id;
  const dmActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=dms`, { token: priya.accessToken });
  expectStatus(dmActivity, 200, 'DM notification list');
  assert.ok(dmActivity.data.notifications.some((item) => item.message?._id === dmMessageId), `DM notification should reference the source message: ${JSON.stringify(dmActivity.data)}`);
  const dmListUnread = await request(`/dms?workspaceId=${workspace._id}`, { token: priya.accessToken });
  expectStatus(dmListUnread, 200, 'DM list unread count');
  assert.ok(dmListUnread.data.dms.find((dm) => dm._id === directMessage._id).unreadCount >= 1);
  const dmHistory = await request(`/dms/${directMessage._id}/messages`, { token: priya.accessToken });
  expectStatus(dmHistory, 200, 'DM history');
  assert.ok(dmHistory.data.messages.some((message) => message._id === dmMessageId));
  expectStatus(await request(`/messages/${dmMessageId}`, { method: 'PUT', token: priya.accessToken, body: { content: 'Unauthorized edit' } }), 403, 'unauthorized DM edit');
  expectStatus(await request(`/messages/${dmMessageId}`, { method: 'PUT', token: alex.accessToken, body: { content: 'Edited DM message' } }), 200, 'edit DM message');
  expectStatus(await request(`/messages/${dmMessageId}`, { method: 'DELETE', token: alex.accessToken }), 200, 'delete DM message');
  const dmListRead = await request(`/dms?workspaceId=${workspace._id}`, { token: priya.accessToken });
  expectStatus(dmListRead, 200, 'DM unread cleared');
  assert.equal(dmListRead.data.dms.find((dm) => dm._id === directMessage._id).unreadCount, 0);
  expectStatus(await request(`/dms/${groupMessage._id}/messages`, { token: workspaceMember.accessToken }), 403, 'unauthorized group DM history');

  expectStatus(await request(`/messages/channel/${publicChannel._id}`, { token: outsiderToken }), 403, 'outsider public history');
  expectStatus(await request(`/messages/channel/${privateChannel._id}`, { token: outsiderToken }), 403, 'outsider private history');
  const memberChannels = await request(`/channels/workspace/${workspace._id}`, { token: workspaceMember.accessToken });
  expectStatus(memberChannels, 200, 'workspace member channel list');
  assert.ok(!memberChannels.data.channels.some((channel) => channel._id === privateChannel._id));
  expectStatus(await request(`/messages/channel/${privateChannel._id}`, { token: workspaceMember.accessToken }), 403, 'workspace member private history');

  expectStatus(await request(`/channels/${publicChannel._id}/join`, { method: 'POST', token: priya.accessToken }), 200, 'join public channel');
  expectStatus(await multipartRequest('/files/upload', {
    fields: { workspaceId: workspace._id, channelId: publicChannel._id },
    files: [{ name: 'smoke.png', type: 'image/png', body: tinyPng }],
  }), 401, 'unauthorized file upload');
  expectStatus(await multipartRequest('/files/upload', {
    token: outsiderToken,
    fields: { workspaceId: workspace._id, channelId: publicChannel._id },
    files: [{ name: 'smoke.png', type: 'image/png', body: tinyPng }],
  }), 403, 'unauthorized workspace file upload');
  const configuredUpload = await multipartRequest('/files/upload', {
    token: alex.accessToken,
    fields: { workspaceId: workspace._id, channelId: publicChannel._id },
    files: [{ name: 'smoke.png', type: 'image/png', body: tinyPng }],
  });
  if (process.env.SMOKE_EXPECT_STORAGE_UNAVAILABLE === 'true') {
    expectStatus(configuredUpload, 503, 'configured storage is required for upload');
    assert.ok(!JSON.stringify(configuredUpload.data).includes('picsum.photos'));
    expectStatus(await multipartRequest('/files/upload', {
      token: alex.accessToken,
      fields: { workspaceId: workspace._id, channelId: publicChannel._id },
      files: [{ name: 'smoke.mp4', type: 'video/mp4', body: tinyMp4 }],
    }), 503, 'video upload reaches configured storage path');
  }
  expectStatus(await multipartRequest('/files/upload', {
    token: alex.accessToken,
    fields: { workspaceId: workspace._id, channelId: publicChannel._id },
    files: [{ name: 'malware.exe', type: 'application/x-msdownload', body: Buffer.from('blocked') }],
  }), 400, 'reject unsupported file type');
  expectStatus(await multipartRequest('/files/upload', {
    token: alex.accessToken,
    fields: { workspaceId: workspace._id, channelId: publicChannel._id },
    files: [{ name: 'too-large.png', type: 'image/png', body: Buffer.alloc(26 * 1024 * 1024) }],
  }), 413, 'reject oversized file');
  expectStatus(await request('/files/upload', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id } }), 400, 'file upload requires files');
  expectStatus(await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, content: 'Untrusted attachment metadata', attachments: [{ type: 'image', url: 'https://attacker.invalid/file.png', publicId: 'attacker/file' }] },
  }), 400, 'reject untrusted attachment metadata');
  const firstMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, content: 'Smoke message' },
  });
  expectStatus(firstMessage, 201, 'create message');
  assert.equal(firstMessage.data.message.forwardedFrom, undefined, 'ordinary messages must not be marked as forwarded');
  const messageId = firstMessage.data.message._id;
  const forwardedMessage = await request(`/messages/${messageId}/forward`, {
    method: 'POST', token: alex.accessToken,
    body: { dmId: directMessage._id },
  });
  expectStatus(forwardedMessage, 201, 'forward channel message to DM');
  assert.equal(forwardedMessage.data.message.content, 'Smoke message');
  assert.equal(forwardedMessage.data.message.forwardedFrom.senderName, alex.user.displayName);
  assert.equal(forwardedMessage.data.message.forwardedFrom.conversationName, `#${publicChannel.name}`);
  assert.equal(forwardedMessage.data.message.mentions.length, 0, 'forward should not re-trigger source mentions');
  const dmForwardSource = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, dmId: directMessage._id, content: 'Forwarded from a DM' },
  });
  expectStatus(dmForwardSource, 201, 'create DM forwarding source');
  assert.equal(dmForwardSource.data.message.forwardedFrom, undefined, 'ordinary DM messages must not be marked as forwarded');
  const forwardedFromDM = await request(`/messages/${dmForwardSource.data.message._id}/forward`, {
    method: 'POST', token: alex.accessToken,
    body: { dmId: groupMessage._id },
  });
  expectStatus(forwardedFromDM, 201, 'forward one-to-one DM message to group DM');
  assert.equal(forwardedFromDM.data.message.forwardedFrom.senderName, alex.user.displayName, 'DM forwards must retain original sender attribution');
  assert.equal(forwardedFromDM.data.message.forwardedFrom.conversationName, 'Direct message', 'DM forwards must identify the source conversation');
  const forwardedFromDMHistory = await request(`/dms/${groupMessage._id}/messages`, { token: priya.accessToken });
  expectStatus(forwardedFromDMHistory, 200, 'read forwarded DM message from history');
  const persistedDMForward = forwardedFromDMHistory.data.messages.find((entry) => entry._id === forwardedFromDM.data.message._id);
  assert.equal(persistedDMForward?.forwardedFrom?.senderName, alex.user.displayName, 'forward attribution must survive history reload');
  assert.equal(persistedDMForward?.forwardedFrom?.conversationName, 'Direct message', 'forward source must survive history reload');
  expectStatus(await request(`/messages/${messageId}/forward`, {
    method: 'POST', token: workspaceMember.accessToken,
    body: { dmId: directMessage._id },
  }), 403, 'forward to inaccessible DM');
  expectStatus(await request(`/messages/${messageId}/forward`, {
    method: 'POST', token: workspaceMember.accessToken,
    body: { channelId: privateChannel._id },
  }), 403, 'forward to inaccessible private channel');
  if (configuredUpload.status === 201 && configuredUpload.data.attachments?.[0]) {
    const attachmentId = configuredUpload.data.attachments[0].uploadId;
    const attachmentSource = await request('/messages', {
      method: 'POST', token: alex.accessToken,
      body: { workspaceId: workspace._id, channelId: publicChannel._id, content: 'Forwarded file smoke test', attachmentIds: [attachmentId] },
    });
    expectStatus(attachmentSource, 201, 'create attachment source message');
    const attachmentForward = await request(`/messages/${attachmentSource.data.message._id}/forward`, {
      method: 'POST', token: alex.accessToken,
      body: { dmId: directMessage._id },
    });
    expectStatus(attachmentForward, 201, 'forward attachment to DM');
    assert.equal(String(attachmentForward.data.message.attachments[0].uploadId), String(attachmentId));
    expectStatus(await request(`/messages/${attachmentSource.data.message._id}`, { method: 'DELETE', token: alex.accessToken }), 200, 'delete original after forwarding attachment');
    const forwardedDMHistory = await request(`/dms/${directMessage._id}/messages`, { token: priya.accessToken });
    expectStatus(forwardedDMHistory, 200, 'recipient can read forwarded attachment message');
    const forwardedFileMessage = forwardedDMHistory.data.messages.find((entry) => entry._id === attachmentForward.data.message._id);
    assert.ok(forwardedFileMessage?.attachments?.length, 'forwarded attachment should remain after source deletion');
    const accessResponse = await fetch(forwardedFileMessage.attachments[0].url, { redirect: 'manual' });
    assert.equal(accessResponse.status, 302, 'DM member should be allowed to access forwarded attachment');
    await accessResponse.body?.cancel();
    expectStatus(await request(`/messages/${attachmentForward.data.message._id}`, { method: 'DELETE', token: alex.accessToken }), 200, 'delete forwarded attachment message');
    const revokedResponse = await fetch(forwardedFileMessage.attachments[0].url, { redirect: 'manual' });
    assert.equal(revokedResponse.status, 404, 'attachment access should be revoked when last referencing message is deleted');
    await revokedResponse.body?.cancel();
  }

  const mentionedMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, content: `Deploy is ready <@${priya.user._id}>` },
  });
  expectStatus(mentionedMessage, 201, 'create message with mention');
  const mentionedMessageId = mentionedMessage.data.message._id;
  assert.ok(mentionedMessage.data.message.mentions.some((id) => String(id) === String(priya.user._id)));
  const mentionActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=mentions`, { token: priya.accessToken });
  expectStatus(mentionActivity, 200, 'mention notification list');
  const mentionNotification = mentionActivity.data.notifications.find((item) => item.message?._id === mentionedMessageId);
  assert.ok(mentionNotification, 'mention notification should reference the source message');
  assert.ok(mentionActivity.data.unreadCount >= 1, 'mention notification should be unread');
  const structuredMention = await request('/messages', {
    method: 'POST',
    token: alex.accessToken,
    body: {
      workspaceId: workspace._id,
      channelId: publicChannel._id,
      content: 'structured mention fallback',
      formattedContent: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'mention', attrs: { id: priya.user._id, label: priya.user.displayName, username: priya.user.username } },
        { type: 'text', text: ' from a chip' },
      ] }] }),
    },
  });
  expectStatus(structuredMention, 201, 'structured mention message');
  assert.equal(structuredMention.data.message.content, `<@${priya.user._id}> from a chip`);
  assert.ok(JSON.parse(structuredMention.data.message.formattedContent).content[0].content.some((node) => node.type === 'mention'), 'mention node should persist in normalized rich content');
  expectStatus(await request(`/notifications/${mentionNotification._id}/read`, { method: 'PATCH', token: workspaceMember.accessToken }), 404, 'notification recipient authorization');
  expectStatus(await request(`/notifications/${mentionNotification._id}/read`, { method: 'PATCH', token: priya.accessToken }), 200, 'notification mark read');
  expectStatus(await request(`/notifications/${mentionNotification._id}/unread`, { method: 'PATCH', token: priya.accessToken }), 200, 'notification mark unread');
  expectStatus(await request('/notifications/read-all', { method: 'POST', token: priya.accessToken, body: { workspaceId: workspace._id } }), 200, 'notification mark all read');
  const priyaUnreadAfterReadAll = await request(`/notifications/unread-count?workspaceId=${workspace._id}`, { token: priya.accessToken });
  expectStatus(priyaUnreadAfterReadAll, 200, 'notification unread count');
  assert.equal(priyaUnreadAfterReadAll.data.unreadCount, 0);
  const selfMention = await request('/messages', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, content: `Self notice <@${alex.user._id}>` } });
  expectStatus(selfMention, 201, 'self mention message');
  const alexMentionActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=mentions`, { token: alex.accessToken });
  expectStatus(alexMentionActivity, 200, 'self mention activity list');
  assert.ok(!alexMentionActivity.data.notifications.some((item) => item.message?._id === selfMention.data.message._id), 'sender must not receive self notification');
  expectStatus(await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, content: `Invalid <@${outsider.data.user._id}>` },
  }), 400, 'reject non-workspace mention');
  const editedMention = await request(`/messages/${mentionedMessageId}`, { method: 'PUT', token: alex.accessToken, body: { content: `Edited mention <@${priya.user._id}>` } });
  expectStatus(editedMention, 200, 'edit mention');
  assert.ok(editedMention.data.message.mentions.some((id) => String(id) === String(priya.user._id)));
  const removedMention = await request(`/messages/${mentionedMessageId}`, { method: 'PUT', token: alex.accessToken, body: { content: 'Mention removed' } });
  expectStatus(removedMention, 200, 'remove mention');
  assert.equal(removedMention.data.message.mentions.length, 0);

  const threadReply = await request('/messages', {
    method: 'POST', token: priya.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, parentMessageId: mentionedMessageId, content: `Checking this <@${alex.user._id}>` },
  });
  expectStatus(threadReply, 201, 'create thread reply');
  const threadReplyId = threadReply.data.message._id;
  assert.equal(String(threadReply.data.parent._id), String(mentionedMessageId));
  assert.equal(threadReply.data.parent.thread.replyCount, 1);
  const threadHistory = await request(`/messages/${mentionedMessageId}/thread`, { token: alex.accessToken });
  expectStatus(threadHistory, 200, 'load thread');
  assert.equal(threadHistory.data.replyCount, 1);
  assert.ok(threadHistory.data.replies.some((message) => message._id === threadReplyId));
  // The reply @mentions Alex, and the server intentionally shows one activity item (a mention) rather than two.
  const threadActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=mentions`, { token: alex.accessToken });
  expectStatus(threadActivity, 200, 'thread notification list');
  assert.ok(threadActivity.data.notifications.some((item) => item.message?._id === threadReplyId && item.threadParent?._id === mentionedMessageId), 'mention inside a thread should reference its parent');
  const priyaThreadActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=threads`, { token: priya.accessToken });
  expectStatus(priyaThreadActivity, 200, 'thread self-notification list');
  assert.ok(!priyaThreadActivity.data.notifications.some((item) => item.message?._id === threadReplyId), 'thread replier must not receive self notification');
  const dmThreadRoot = await request('/messages', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, dmId: directMessage._id, content: 'DM thread root' } });
  expectStatus(dmThreadRoot, 201, 'create DM thread root');
  const dmThreadReply = await request('/messages', { method: 'POST', token: priya.accessToken, body: { workspaceId: workspace._id, dmId: directMessage._id, parentMessageId: dmThreadRoot.data.message._id, content: 'DM thread reply' } });
  expectStatus(dmThreadReply, 201, 'create DM thread reply');
  const dmThreadHistory = await request(`/messages/${dmThreadRoot.data.message._id}/thread`, { token: alex.accessToken });
  expectStatus(dmThreadHistory, 200, 'load DM thread');
  assert.equal(dmThreadHistory.data.replyCount, 1);
  expectStatus(await request(`/messages/${mentionedMessageId}/thread`, { token: outsiderToken }), 403, 'unauthorized thread access');
  expectStatus(await request('/messages', {
    method: 'POST', token: outsiderToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, parentMessageId: mentionedMessageId, content: 'Unauthorized thread reply' },
  }), 403, 'unauthorized thread reply');
  expectStatus(await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, dmId: directMessage._id, parentMessageId: mentionedMessageId, content: 'Wrong thread context' },
  }), 400, 'thread parent context mismatch');

  const richDocument = JSON.stringify({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: `Bold italic mention <@${priya.user._id}>`, marks: [{ type: 'bold' }, { type: 'italic' }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A formatted list item' }] }] }] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'const ready = true;' }] },
  ] });
  const richChannelMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, content: 'Rich fallback', formattedContent: richDocument },
  });
  expectStatus(richChannelMessage, 201, 'channel rich message');
  assert.match(richChannelMessage.data.message.formattedContent, /bulletList/);
  assert.ok(richChannelMessage.data.message.mentions.some((id) => String(id) === String(priya.user._id)));
  const richDMMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, dmId: directMessage._id, content: 'DM rich fallback', formattedContent: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bold DM', marks: [{ type: 'bold' }] }] }] }) },
  });
  expectStatus(richDMMessage, 201, 'DM rich message');
  const richGroupMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, dmId: groupMessage._id, content: 'Group rich fallback', formattedContent: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Group DM italic', marks: [{ type: 'italic' }] }] }] }) },
  });
  expectStatus(richGroupMessage, 201, 'group DM rich message');
  const richThreadReply = await request('/messages', {
    method: 'POST', token: priya.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, parentMessageId: richChannelMessage.data.message._id, content: 'Thread rich fallback', formattedContent: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Thread code', marks: [{ type: 'code' }] }] }] }) },
  });
  expectStatus(richThreadReply, 201, 'thread rich reply');
  const editedRich = await request(`/messages/${richChannelMessage.data.message._id}`, { method: 'PUT', token: alex.accessToken, body: { content: 'Edited rich fallback', formattedContent: JSON.stringify({ type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited formatted message', marks: [{ type: 'strike' }] }] }] }] }) } });
  expectStatus(editedRich, 200, 'edit formatted message');
  assert.match(editedRich.data.message.formattedContent, /blockquote/);

  const privateSearchMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: privateChannel._id, content: `PrivateSearchSecret${suffix}` },
  });
  expectStatus(privateSearchMessage, 201, 'create private search message');
  expectStatus(await request(`/messages/${privateSearchMessage.data.message._id}/thread`, { token: workspaceMember.accessToken }), 403, 'private message link remains inaccessible');
  expectStatus(await request(`/messages/${privateSearchMessage.data.message._id}/thread`, { token: priya.accessToken }), 200, 'private message link opens for channel member');
  const privateSearchHidden = await request(`/search?workspaceId=${workspace._id}&q=${encodeURIComponent(`PrivateSearchSecret${suffix}`)}`, { token: workspaceMember.accessToken });
  expectStatus(privateSearchHidden, 200, 'private search for non-member');
  assert.equal(privateSearchHidden.data.results.length, 0, 'private message must not appear in search');
  const privateSearchVisible = await request(`/search?workspaceId=${workspace._id}&q=${encodeURIComponent(`PrivateSearchSecret${suffix}`)}`, { token: alex.accessToken });
  expectStatus(privateSearchVisible, 200, 'private search for member');
  assert.ok(privateSearchVisible.data.results.some((result) => result._id === privateSearchMessage.data.message._id));

  const dmSearchMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, dmId: directMessage._id, content: `DMSearchSecret${suffix}` },
  });
  expectStatus(dmSearchMessage, 201, 'create DM search message');
  expectStatus(await request(`/messages/${dmSearchMessage.data.message._id}/thread`, { token: workspaceMember.accessToken }), 403, 'DM message link remains inaccessible');
  expectStatus(await request(`/messages/${dmSearchMessage.data.message._id}/thread`, { token: priya.accessToken }), 200, 'DM message link opens for participant');
  const dmSearchHidden = await request(`/search?workspaceId=${workspace._id}&q=${encodeURIComponent(`DMSearchSecret${suffix}`)}`, { token: workspaceMember.accessToken });
  expectStatus(dmSearchHidden, 200, 'DM search for non-member');
  assert.equal(dmSearchHidden.data.results.length, 0, 'inaccessible DM message must not appear in search');
  const dmSearchVisible = await request(`/search?workspaceId=${workspace._id}&q=${encodeURIComponent(`DMSearchSecret${suffix}`)}`, { token: priya.accessToken });
  expectStatus(dmSearchVisible, 200, 'DM search for participant');
  assert.ok(dmSearchVisible.data.results.some((result) => result._id === dmSearchMessage.data.message._id));

  const threadSearch = await request(`/search?workspaceId=${workspace._id}&q=${encodeURIComponent('Checking this')}&channelId=${publicChannel._id}&senderId=${priya.user._id}&hasAttachments=false`, { token: alex.accessToken });
  expectStatus(threadSearch, 200, 'search filters and thread replies');
  assert.ok(threadSearch.data.results.some((result) => result._id === threadReplyId && result.isThreadReply && result.threadParentId === mentionedMessageId));
  assert.ok(threadSearch.data.results.every((result) => result.channel && result.channel._id === publicChannel._id));

  const savedFirst = await request('/saved', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, messageId },
  });
  expectStatus(savedFirst, 201, 'save message');
  expectStatus(await request('/saved', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, messageId },
  }), 409, 'prevent duplicate save');
  const savedList = await request(`/saved?workspaceId=${workspace._id}`, { token: alex.accessToken });
  expectStatus(savedList, 200, 'saved message list');
  assert.ok(savedList.data.saved.some((item) => item.message && item.message._id === messageId));
  expectStatus(await request(`/saved/${messageId}`, { method: 'DELETE', token: alex.accessToken }), 200, 'unsave message');
  const unsavedList = await request(`/saved?workspaceId=${workspace._id}`, { token: alex.accessToken });
  expectStatus(unsavedList, 200, 'saved list after unsave');
  assert.ok(!unsavedList.data.saved.some((item) => item.message && item.message._id === messageId));
  expectStatus(await request('/saved', { method: 'POST', token: workspaceMember.accessToken, body: { workspaceId: workspace._id, messageId: privateSearchMessage.data.message._id } }), 403, 'unauthorized private save');
  expectStatus(await request('/saved', { method: 'POST', token: workspaceMember.accessToken, body: { workspaceId: workspace._id, messageId: dmSearchMessage.data.message._id } }), 403, 'unauthorized DM save');

  expectStatus(await request(`/messages/${messageId}/pin`, { method: 'POST', token: alex.accessToken }), 200, 'pin message');
  const pinnedList = await request(`/channels/${publicChannel._id}/pins`, { token: alex.accessToken });
  expectStatus(pinnedList, 200, 'pinned message list');
  assert.ok(pinnedList.data.pinnedMessages.some((item) => item.message && item.message._id === messageId));
  expectStatus(await request(`/messages/${messageId}/pin`, { method: 'POST', token: priya.accessToken }), 403, 'pin authorization');
  expectStatus(await request(`/messages/${messageId}/pin`, { method: 'DELETE', token: alex.accessToken }), 200, 'unpin message');
  const unpinnedList = await request(`/channels/${publicChannel._id}/pins`, { token: alex.accessToken });
  expectStatus(unpinnedList, 200, 'pinned list after unpin');
  assert.ok(!unpinnedList.data.pinnedMessages.some((item) => item.message && item.message._id === messageId));
  expectStatus(await request(`/messages/${privateSearchMessage.data.message._id}/pin`, { method: 'POST', token: workspaceMember.accessToken }), 403, 'unauthorized private pin');
  const pinCleanupMessage = await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: workspace._id, channelId: publicChannel._id, content: `Pin cleanup ${suffix}` },
  });
  expectStatus(pinCleanupMessage, 201, 'create pin cleanup message');
  const pinCleanupId = pinCleanupMessage.data.message._id;
  expectStatus(await request(`/messages/${pinCleanupId}/pin`, { method: 'POST', token: alex.accessToken }), 200, 'pin cleanup message');
  expectStatus(await request(`/messages/${pinCleanupId}`, { method: 'DELETE', token: alex.accessToken }), 200, 'delete pinned message');
  const pinsAfterDelete = await request(`/channels/${publicChannel._id}/pins`, { token: alex.accessToken });
  expectStatus(pinsAfterDelete, 200, 'pinned list after message deletion');
  assert.ok(!pinsAfterDelete.data.pinnedMessages.some((item) => item.message && item.message._id === pinCleanupId));

  const reactionAdd = await request(`/messages/${mentionedMessageId}/react`, { method: 'POST', token: priya.accessToken, body: { emoji: '👍' } });
  expectStatus(reactionAdd, 200, 'add reaction');
  assert.equal(reactionAdd.data.reactions.find((reaction) => reaction.emoji === '👍').count, 1);
  const reactionActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=reactions`, { token: alex.accessToken });
  expectStatus(reactionActivity, 200, 'reaction notification list');
  const reactionNotificationCount = reactionActivity.data.notifications.filter((item) => item.message?._id === mentionedMessageId && item.metadata?.emoji === '👍').length;
  assert.equal(reactionNotificationCount, 1, 'reaction should create one notification');
  const duplicateReaction = await request(`/messages/${mentionedMessageId}/react`, { method: 'POST', token: priya.accessToken, body: { emoji: '👍' } });
  expectStatus(duplicateReaction, 200, 'prevent duplicate reaction');
  assert.equal(duplicateReaction.data.reactions.find((reaction) => reaction.emoji === '👍').count, 1);
  const dedupedReactionActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=reactions`, { token: alex.accessToken });
  expectStatus(dedupedReactionActivity, 200, 'deduplicated reaction notification list');
  assert.equal(dedupedReactionActivity.data.notifications.filter((item) => item.message?._id === mentionedMessageId && item.metadata?.emoji === '👍').length, 1);
  const secondReaction = await request(`/messages/${mentionedMessageId}/react`, { method: 'POST', token: alex.accessToken, body: { emoji: '👍' } });
  expectStatus(secondReaction, 200, 'second user reaction');
  assert.equal(secondReaction.data.reactions.find((reaction) => reaction.emoji === '👍').count, 2);
  const reactionRemove = await request(`/messages/${mentionedMessageId}/react`, { method: 'DELETE', token: priya.accessToken, body: { emoji: '👍' } });
  expectStatus(reactionRemove, 200, 'remove reaction');
  assert.equal(reactionRemove.data.reactions.find((reaction) => reaction.emoji === '👍').count, 1);
  const threadReaction = await request(`/messages/${threadReplyId}/react`, { method: 'POST', token: alex.accessToken, body: { emoji: '✅' } });
  expectStatus(threadReaction, 200, 'react to thread reply');
  assert.equal(threadReaction.data.reactions.find((reaction) => reaction.emoji === '✅').count, 1);
  expectStatus(await request(`/messages/${threadReplyId}/react`, { method: 'DELETE', token: alex.accessToken, body: { emoji: '✅' } }), 200, 'remove thread reaction');
  expectStatus(await request(`/messages/${mentionedMessageId}/react`, { method: 'POST', token: outsiderToken, body: { emoji: '🎉' } }), 403, 'reaction authorization');

  expectStatus(await request('/notifications/preferences', { method: 'PATCH', token: alex.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, muted: true } }), 200, 'mute channel notifications');
  const mutedThreadRoot = await request('/messages', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, content: 'Muted notification root' } });
  expectStatus(mutedThreadRoot, 201, 'muted thread root');
  const mutedThreadReply = await request('/messages', { method: 'POST', token: priya.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, parentMessageId: mutedThreadRoot.data.message._id, content: 'Muted channel reply' } });
  expectStatus(mutedThreadReply, 201, 'muted channel reply');
  const mutedThreadActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=threads`, { token: alex.accessToken });
  expectStatus(mutedThreadActivity, 200, 'muted channel activity');
  // Muting pauses alerts (push/sound) but keeps the item in the activity feed, flagged as suppressed.
  const mutedItem = mutedThreadActivity.data.notifications.find((item) => item.message?._id === mutedThreadReply.data.message._id);
  assert.ok(!mutedItem || mutedItem.metadata?.deliverySuppressed === true, 'muted channel should suppress delivery of thread activity');
  expectStatus(await request('/notifications/preferences', { method: 'PATCH', token: alex.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, muted: false } }), 200, 'unmute channel notifications');

  expectStatus(await request('/notifications/read-all', { method: 'POST', token: priya.accessToken, body: { workspaceId: workspace._id } }), 200, 'clear DM activity before mute');
  expectStatus(await request('/notifications/preferences', { method: 'PATCH', token: priya.accessToken, body: { workspaceId: workspace._id, dmId: directMessage._id, muted: true } }), 200, 'mute DM notifications');
  const mutedDMMessage = await request('/messages', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, dmId: directMessage._id, content: 'Muted DM notification' } });
  expectStatus(mutedDMMessage, 201, 'muted DM message');
  const mutedDMActivity = await request(`/notifications?workspaceId=${workspace._id}&filter=dms`, { token: priya.accessToken });
  expectStatus(mutedDMActivity, 200, 'muted DM activity');
  assert.ok(!mutedDMActivity.data.notifications.some((item) => item.message?._id === mutedDMMessage.data.message._id), 'muted DM should suppress DM activity');
  expectStatus(await request('/notifications/preferences', { method: 'PATCH', token: priya.accessToken, body: { workspaceId: workspace._id, dmId: directMessage._id, muted: false, dndUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() } }), 200, 'enable DND');
  const dndPreference = await request(`/notifications/preferences?workspaceId=${workspace._id}`, { token: priya.accessToken });
  expectStatus(dndPreference, 200, 'DND preference');
  assert.ok(new Date(dndPreference.data.preference.dndUntil).getTime() > Date.now(), 'DND should persist until the requested time');
  expectStatus(await request('/notifications/preferences', { method: 'PATCH', token: priya.accessToken, body: { workspaceId: workspace._id, dndUntil: null } }), 200, 'disable DND');
  const granularPreference = await request('/notifications/preferences', {
    method: 'PATCH', token: alex.accessToken,
    body: { workspaceId: workspace._id, level: 'important', notifyThreadReplies: false, notifyReactions: false, playSound: false },
  });
  expectStatus(granularPreference, 200, 'save granular notification preference');
  assert.equal(granularPreference.data.preference.level, 'important');
  assert.equal(granularPreference.data.preference.notifyThreadReplies, false);
  assert.equal(granularPreference.data.preference.notifyReactions, false);
  assert.equal(granularPreference.data.preference.playSound, false);
  expectStatus(await request('/notifications/preferences', {
    method: 'PATCH', token: alex.accessToken,
    body: { workspaceId: workspace._id, level: 'all', notifyThreadReplies: true, notifyReactions: true, playSound: true },
  }), 200, 'restore granular notification preference');

  const channelUnread = await request(`/channels/workspace/${workspace._id}`, { token: priya.accessToken });
  expectStatus(channelUnread, 200, 'channel unread count');
  assert.ok(channelUnread.data.channels.find((channel) => channel._id === publicChannel._id).unreadCount >= 1);

  const history = await request(`/messages/channel/${publicChannel._id}`, { token: priya.accessToken });
  expectStatus(history, 200, 'authorized history');
  assert.ok(history.data.messages.some((message) => message._id === messageId));
  // Reading history must not mark the channel read; the explicit call does.
  const stillUnread = await request(`/channels/workspace/${workspace._id}`, { token: priya.accessToken });
  assert.ok(stillUnread.data.channels.find((channel) => channel._id === publicChannel._id).unreadCount >= 1, 'history fetch must not clear unread');
  expectStatus(await request(`/channels/${publicChannel._id}/mark-read`, { method: 'PUT', token: priya.accessToken }), 200, 'explicit mark read');
  const channelRead = await request(`/channels/workspace/${workspace._id}`, { token: priya.accessToken });
  expectStatus(channelRead, 200, 'channel unread cleared');
  assert.equal(channelRead.data.channels.find((channel) => channel._id === publicChannel._id).unreadCount, 0);
  expectStatus(await request(`/messages/${messageId}`, { method: 'PUT', token: alex.accessToken, body: { content: 'Edited smoke message' } }), 200, 'edit message');
  expectStatus(await request(`/messages/${messageId}`, { method: 'DELETE', token: alex.accessToken }), 200, 'delete message');
  expectStatus(await request('/messages', {
    method: 'POST', token: alex.accessToken,
    body: { workspaceId: '000000000000000000000000', channelId: publicChannel._id, content: 'Wrong workspace' },
  }), 400, 'workspace/channel mismatch');

  let socketClient;
  try {
    socketClient = require('../../web/node_modules/socket.io-client').io;
  } catch {
    console.log('Socket.IO smoke skipped: install web dependencies first');
  }
  if (socketClient) {
    const notificationSocket = socketClient(SOCKET_URL, { auth: { token: priya.accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Notification Socket.IO event timed out')), 5000);
      let eventCount = 0;
      notificationSocket.on('connect_error', reject);
      notificationSocket.on('connect', () => notificationSocket.timeout(3000).emit('user:join', alex.user._id, async (timeoutError, roomAck) => {
        try {
          assert.ifError(timeoutError);
          assert.equal(roomAck.ok, false, 'socket must reject another user room');
          notificationSocket.on('notification:new', (notification) => { if (notification.type === 'mention') eventCount += 1; });
          const sent = await request('/messages', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, content: `Live notification <@${priya.user._id}>` } });
          expectStatus(sent, 201, 'live notification message');
          setTimeout(async () => {
            try { assert.equal(eventCount, 1, 'notification:new should be delivered once'); await request(`/messages/${sent.data.message._id}`, { method: 'DELETE', token: alex.accessToken }); clearTimeout(timer); notificationSocket.disconnect(); resolve(); } catch (err) { reject(err); }
          }, 500);
        } catch (err) { reject(err); }
      }));
    });
    const socket = socketClient(SOCKET_URL, { auth: { token: outsiderToken } });
    await new Promise((resolve, reject) => {
      socket.on('connect_error', reject);
      socket.on('connect', () => socket.timeout(3000).emit('channel:join', publicChannel._id, (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError);
          assert.equal(ack.ok, false);
          socket.disconnect();
          resolve();
        } catch (err) { reject(err); }
      }));
    });

    const authorizedSocket = socketClient(SOCKET_URL, { auth: { token: alex.accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket message event timed out')), 5000);
      let eventCount = 0;
      authorizedSocket.on('connect_error', reject);
      authorizedSocket.on('connect', () => authorizedSocket.timeout(3000).emit('channel:join', publicChannel._id, async (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError);
          assert.equal(ack.ok, true);
          authorizedSocket.on('message:new', (message) => {
            if (message.content === 'Socket smoke message') eventCount += 1;
          });
          const sent = await request('/messages', {
            method: 'POST', token: alex.accessToken,
            body: { workspaceId: workspace._id, channelId: publicChannel._id, content: 'Socket smoke message' },
          });
          expectStatus(sent, 201, 'socket message create');
          setTimeout(() => {
            try {
              assert.equal(eventCount, 1, 'message:new should be delivered once');
              clearTimeout(timer);
              authorizedSocket.disconnect();
              resolve();
            } catch (err) { reject(err); }
          }, 500);
        } catch (err) { reject(err); }
      }));
    });

    const threadSocket = socketClient(SOCKET_URL, { auth: { token: alex.accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Thread Socket.IO event timed out')), 5000);
      let eventCount = 0;
      threadSocket.on('connect_error', reject);
      threadSocket.on('connect', () => threadSocket.timeout(3000).emit('thread:join', mentionedMessageId, async (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError);
          assert.equal(ack.ok, true);
          threadSocket.on('thread:new', (message) => { if (message.content === 'Socket thread reply') eventCount += 1; });
          const sent = await request('/messages', { method: 'POST', token: priya.accessToken, body: { workspaceId: workspace._id, channelId: publicChannel._id, parentMessageId: mentionedMessageId, content: 'Socket thread reply' } });
          expectStatus(sent, 201, 'socket thread reply create');
          setTimeout(async () => {
            try {
              assert.equal(eventCount, 1, 'thread:new should be delivered once');
              await request(`/messages/${sent.data.message._id}`, { method: 'DELETE', token: alex.accessToken });
              const afterDelete = await request(`/messages/${mentionedMessageId}/thread`, { token: alex.accessToken });
              expectStatus(afterDelete, 200, 'thread reply count after delete');
              assert.equal(afterDelete.data.replyCount, 1);
              clearTimeout(timer); threadSocket.disconnect(); resolve();
            } catch (err) { reject(err); }
          }, 500);
        } catch (err) { reject(err); }
      }));
    });

    const reactionReceiver = socketClient(SOCKET_URL, { auth: { token: priya.accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reaction Socket.IO event timed out')), 5000);
      let eventCount = 0;
      reactionReceiver.on('connect_error', reject);
      reactionReceiver.on('connect', () => reactionReceiver.timeout(3000).emit('channel:join', publicChannel._id, async (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError); assert.equal(ack.ok, true);
          reactionReceiver.on('message:reaction', (payload) => { if (String(payload.messageId) === String(mentionedMessageId)) eventCount += 1; });
          const reacted = await request(`/messages/${mentionedMessageId}/react`, { method: 'POST', token: alex.accessToken, body: { emoji: '🎉' } });
          expectStatus(reacted, 200, 'socket reaction create');
          setTimeout(async () => {
            try { assert.equal(eventCount, 1, 'message:reaction should be delivered once'); await request(`/messages/${mentionedMessageId}/react`, { method: 'DELETE', token: alex.accessToken, body: { emoji: '🎉' } }); clearTimeout(timer); reactionReceiver.disconnect(); resolve(); } catch (err) { reject(err); }
          }, 500);
        } catch (err) { reject(err); }
      }));
    });

    const pinReceiver = socketClient(SOCKET_URL, { auth: { token: priya.accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pin Socket.IO event timed out')), 5000);
      let eventCount = 0;
      pinReceiver.on('connect_error', reject);
      pinReceiver.on('connect', () => pinReceiver.timeout(3000).emit('channel:join', publicChannel._id, async (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError); assert.equal(ack.ok, true);
          pinReceiver.on('message:pinned', (payload) => { if (String(payload.messageId) === String(mentionedMessageId) && payload.isPinned) eventCount += 1; });
          const pinned = await request(`/messages/${mentionedMessageId}/pin`, { method: 'POST', token: alex.accessToken });
          expectStatus(pinned, 200, 'socket pin create');
          setTimeout(async () => {
            try {
              assert.equal(eventCount, 1, 'message:pinned should be delivered once');
              await request(`/messages/${mentionedMessageId}/pin`, { method: 'DELETE', token: alex.accessToken });
              clearTimeout(timer); pinReceiver.disconnect(); resolve();
            } catch (err) { reject(err); }
          }, 500);
        } catch (err) { reject(err); }
      }));
    });

    const unauthorizedDMSocket = socketClient(SOCKET_URL, { auth: { token: workspaceMember.accessToken } });
    await new Promise((resolve, reject) => {
      unauthorizedDMSocket.on('connect_error', reject);
      unauthorizedDMSocket.on('connect', () => unauthorizedDMSocket.timeout(3000).emit('dm:join', directMessage._id, (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError);
          assert.equal(ack.ok, false);
          unauthorizedDMSocket.disconnect();
          resolve();
        } catch (err) { reject(err); }
      }));
    });

    const dmSocket = socketClient(SOCKET_URL, { auth: { token: priya.accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DM Socket.IO message event timed out')), 5000);
      let eventCount = 0;
      let notificationCount = 0;
      dmSocket.on('connect_error', reject);
      dmSocket.on('connect', () => dmSocket.timeout(3000).emit('dm:join', directMessage._id, async (timeoutError, ack) => {
        try {
          assert.ifError(timeoutError);
          assert.equal(ack.ok, true);
          dmSocket.on('message:new', (message) => { if (message.content === 'Socket DM smoke message') eventCount += 1; });
          dmSocket.on('notification:new', (notification) => { if (notification.type === 'direct_message' && notification.metadata?.preview === 'Socket DM smoke message') notificationCount += 1; });
          const sent = await request('/messages', { method: 'POST', token: alex.accessToken, body: { workspaceId: workspace._id, dmId: directMessage._id, content: 'Socket DM smoke message' } });
          expectStatus(sent, 201, 'Socket DM message create');
          setTimeout(async () => {
            try {
              assert.equal(eventCount, 1, 'DM message:new should be delivered once');
              assert.equal(notificationCount, 1, 'DM notification:new should arrive even while DM room is joined');
              await request(`/messages/${sent.data.message._id}`, { method: 'DELETE', token: alex.accessToken });
              clearTimeout(timer);
              dmSocket.disconnect();
              resolve();
            } catch (err) { reject(err); }
          }, 500);
        } catch (err) { reject(err); }
      }));
    });

    const typingReceiver = socketClient(SOCKET_URL, { auth: { token: alex.accessToken } });
    const typingSender = socketClient(SOCKET_URL, { auth: { token: priya.accessToken } });
    await Promise.all([
      new Promise((resolve, reject) => { typingReceiver.on('connect_error', reject); typingReceiver.on('connect', resolve); }),
      new Promise((resolve, reject) => { typingSender.on('connect_error', reject); typingSender.on('connect', resolve); }),
    ]);
    await Promise.all([
      new Promise((resolve, reject) => typingReceiver.timeout(3000).emit('dm:join', directMessage._id, (timeoutError, ack) => { if (timeoutError) reject(timeoutError); else { try { assert.equal(ack.ok, true); resolve(); } catch (err) { reject(err); } } })),
      new Promise((resolve, reject) => typingSender.timeout(3000).emit('dm:join', directMessage._id, (timeoutError, ack) => { if (timeoutError) reject(timeoutError); else { try { assert.equal(ack.ok, true); resolve(); } catch (err) { reject(err); } } })),
    ]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Typing event timed out')), 4000);
      typingReceiver.once('typing:update', (payload) => {
        try { assert.equal(payload.roomId, directMessage._id); assert.equal(payload.action, 'start'); clearTimeout(timer); resolve(); } catch (err) { reject(err); }
      });
      typingSender.emit('typing:start', { roomType: 'dm', roomId: directMessage._id });
    });
    typingSender.emit('typing:stop', { roomType: 'dm', roomId: directMessage._id });
    typingReceiver.disconnect();
    typingSender.disconnect();

    const presenceSocket = socketClient(SOCKET_URL, { auth: { token: outsiderToken } });
    await new Promise((resolve, reject) => { presenceSocket.on('connect_error', reject); presenceSocket.on('connect', resolve); });
    await delay(200);
    // Profiles are visible only to people sharing a workspace (or the user themselves).
    expectStatus(await request(`/users/profile/${outsider.data.user._id}`, { token: alex.accessToken }), 404, 'profile hidden from unrelated users');
    const onlineProfile = await request(`/users/profile/${outsider.data.user._id}`, { token: outsiderToken });
    expectStatus(onlineProfile, 200, 'presence profile online');
    assert.equal(onlineProfile.data.user.status, 'online');
    presenceSocket.disconnect();
    await delay(250);
    const offlineProfile = await request(`/users/profile/${outsider.data.user._id}`, { token: outsiderToken });
    expectStatus(offlineProfile, 200, 'presence profile offline');
    assert.equal(offlineProfile.data.user.status, 'offline');

    const reconnectSocket = socketClient(SOCKET_URL, { auth: { token: alex.accessToken } });
    await new Promise((resolve, reject) => { reconnectSocket.on('connect_error', reject); reconnectSocket.on('connect', resolve); });
    reconnectSocket.disconnect();
    await new Promise((resolve, reject) => { reconnectSocket.once('connect_error', reject); reconnectSocket.once('connect', resolve); reconnectSocket.connect(); });
    await new Promise((resolve, reject) => reconnectSocket.timeout(3000).emit('dm:join', directMessage._id, (timeoutError, ack) => { if (timeoutError) reject(timeoutError); else { try { assert.equal(ack.ok, true); resolve(); } catch (err) { reject(err); } } }));
    reconnectSocket.disconnect();
  }

  expectStatus(await request('/auth/logout', { method: 'POST', token: alex.accessToken }), 200, 'logout');
  expectStatus(await request('/auth/refresh', { method: 'POST', body: { refreshToken: alex.refreshToken } }), 401, 'refresh invalidated after logout');

  console.log('Smoke tests passed: auth, profiles, workspaces, channels, DMs, messaging, forwarding, threads, reactions, search, saved messages, pins, notifications, preferences, uploads, authorization, presence, typing, reconnect, and Socket.IO event delivery');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
