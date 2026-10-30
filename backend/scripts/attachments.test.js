const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { boot, assert } = require('./lib/harness');
const t = boot({ LOCAL_UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'unichat-up-')) });
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

const files = {
  image: { name: 'pic.png', type: 'image/png', bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]) },
  video: { name: 'clip.mp4', type: 'video/mp4', bytes: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(64, 2)]) },
  document: { name: 'doc.pdf', type: 'application/pdf', bytes: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 3)]) },
};

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const { accessSignature } = (() => ({ accessSignature: (id, user, exp) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${id}.${user}.${exp}`).digest('hex') }))();
  const [owner, member, outsider] = [await register('owner'), await register('member'), await register('outsider')];
  const workspace = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Files Co' } }), 201).workspace;
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: [{ user: member.id, role: 'member' }, { user: outsider.id, role: 'member' }] } });
  const priv = ok(await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, name: 'vault', type: 'private', memberIds: [member.id] } }), 201).channel;

  const upload = async (token, file) => {
    const form = new FormData();
    form.append('workspaceId', workspace._id); form.append('channelId', priv._id);
    form.append('files', new Blob([file.bytes], { type: file.type }), file.name);
    const response = await fetch(`http://127.0.0.1:${port}/api/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.9' }, body: form });
    return { status: response.status, body: await response.json() };
  };
  const download = async (url) => { const r = await fetch(url, { redirect: 'manual' }); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };

  // Member's socket, to inspect what is broadcast.
  const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: member.token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const events = [];
  socket.onAny((event, payload) => events.push({ event, payload }));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  await sleep(300);

  const sent = {};
  for (const [kind, file] of Object.entries(files)) {
    const up = ok(await upload(owner.token, file), 201).attachments[0];
    assert.equal(up.type, kind); assert.ok(up.url.includes('/files/access/'), 'sender gets a signed access URL');
    const message = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: priv._id, content: `with ${kind}`, attachmentIds: [up.uploadId] } }), 201).message;
    sent[kind] = { up, message };
    // Sender's HTTP response: working URL, no raw storage fields.
    const att = message.attachments[0];
    assert.ok(att.url.includes('/files/access/')); assert.equal(att.secureUrl, undefined); assert.equal(att.publicId, undefined);
    const got = await download(att.url); assert.equal(got.status, 200); assert.ok(got.bytes.equals(files[kind].bytes), `${kind} bytes round-trip`);
  }
  await sleep(300);
  // What other devices got over the socket: never a URL or storage identifier.
  const broadcasts = events.filter((e) => e.event === 'message:new');
  assert.equal(broadcasts.length, 3);
  for (const { payload } of broadcasts) {
    const att = payload.attachments[0];
    assert.equal(att.url, ''); assert.equal(att.urlRequired, true); assert.equal(att.secureUrl, undefined); assert.equal(att.publicId, undefined);
    assert.ok(att.uploadId);
  }
  assert.equal(JSON.stringify(events).includes('/files/access/'), false, 'no signed URL ever travels over the socket');
  console.log('ok - sender gets signed URLs; socket payloads carry none');

  // Recipient resolves fresh URLs on demand and they work, for each type.
  const ids = Object.values(sent).map((s) => s.up.uploadId);
  const resolved = ok(await call('/files/urls', { method: 'POST', token: member.token, body: { uploadIds: ids } })).urls;
  assert.equal(Object.keys(resolved).length, 3);
  for (const [kind, s] of Object.entries(sent)) { const got = await download(resolved[s.up.uploadId].url); assert.equal(got.status, 200, kind); assert.ok(got.bytes.equals(files[kind].bytes)); }
  assert.equal(Object.keys(ok(await call('/files/urls', { method: 'POST', token: outsider.token, body: { uploadIds: ids } })).urls).length, 0, 'workspace member outside the private channel gets nothing');
  assert.equal((await call('/files/urls', { method: 'POST', token: member.token, body: { uploadIds: ['nope'] } })).status, 400);
  console.log('ok - on-demand URLs work for member, denied for outsider');

  // A URL minted for one user is useless to another; forged/expired signatures fail.
  const imageId = sent.image.up.uploadId;
  const memberUrl = new URL(resolved[imageId].url);
  const swapped = new URL(memberUrl); swapped.searchParams.set('user', outsider.id);
  assert.equal((await download(swapped.href)).status, 404, 'cannot reuse another user\'s link');
  const past = Math.floor(Date.now() / 1000) - 10;
  const expired = new URL(memberUrl); expired.searchParams.set('expires', past); expired.searchParams.set('signature', accessSignature(imageId, member.id, past));
  assert.equal((await download(expired.href)).status, 404, 'correctly signed but expired link is rejected');
  const far = Math.floor(Date.now() / 1000) + 86400;
  const longLived = new URL(memberUrl); longLived.searchParams.set('expires', far); longLived.searchParams.set('signature', accessSignature(imageId, member.id, far));
  assert.equal((await download(longLived.href)).status, 404, 'cannot mint long-lived links');
  const unsigned = new URL(memberUrl); unsigned.searchParams.set('signature', 'a'.repeat(64));
  assert.equal((await download(unsigned.href)).status, 404);
  const outsiderForged = new URL(memberUrl); const exp = Math.floor(Date.now() / 1000) + 200;
  outsiderForged.searchParams.set('user', outsider.id); outsiderForged.searchParams.set('expires', exp); outsiderForged.searchParams.set('signature', accessSignature(imageId, outsider.id, exp));
  assert.equal((await download(outsiderForged.href)).status, 404, 'even a validly signed link is re-checked against membership');
  console.log('ok - expired / forged / cross-user links rejected');

  // Removal and deletion revoke access to already-issued links.
  assert.equal((await download(memberUrl.href)).status, 200);
  ok(await call(`/channels/${priv._id}/members/${member.id}`, { method: 'DELETE', token: owner.token }));
  assert.equal((await download(memberUrl.href)).status, 404, 'removed member\'s existing link stops working');
  assert.equal(Object.keys(ok(await call('/files/urls', { method: 'POST', token: member.token, body: { uploadIds: [imageId] } })).urls).length, 0);
  const docUrl = ok(await call('/files/urls', { method: 'POST', token: owner.token, body: { uploadIds: [sent.document.up.uploadId] } })).urls[sent.document.up.uploadId].url;
  assert.equal((await download(docUrl)).status, 200);
  ok(await call(`/messages/${sent.document.message._id}`, { method: 'DELETE', token: owner.token }));
  assert.equal((await download(docUrl)).status, 404, 'deleting the message revokes the file');
  assert.equal(Object.keys(ok(await call('/files/urls', { method: 'POST', token: owner.token, body: { uploadIds: [sent.document.up.uploadId] } })).urls).length, 0);
  console.log('ok - removal and message deletion revoke file access');

  // Mime spoofing: bytes must match the declared type.
  assert.equal((await upload(owner.token, { name: 'evil.png', type: 'image/png', bytes: Buffer.from('<script>alert(1)</script>') })).status, 400);
  assert.equal((await upload(owner.token, { name: 'x.exe', type: 'application/x-msdownload', bytes: Buffer.alloc(32) })).status, 400);
  console.log('ok - content/type mismatch rejected');
  socket.disconnect();
});
