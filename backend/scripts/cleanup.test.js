const { boot, assert } = require('./lib/harness');
const t = boot();

t.main(async ({ call, ok, register, sleep }) => {
  const mongoose = require('mongoose');
  const StoredAttachment = require('../src/models/StoredAttachment');
  const Message = require('../src/models/Message');
  const JobLock = require('../src/models/JobLock');
  const { cleanupOrphanedAttachments } = require('../src/utils/cleanupAttachments');
  const { acquireLease } = require('../src/services/jobLock');
  const owner = await register('owner');
  const W = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Cleanup' } }), 201).workspace;
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: owner.token })).channels.find((c) => c.name === 'general');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  let n = 0;
  const make = async (extra = {}) => (await StoredAttachment.collection.insertOne({
    workspace: new mongoose.Types.ObjectId(W._id), channel: new mongoose.Types.ObjectId(general._id), dm: null, parentMessage: null, uploadedBy: new mongoose.Types.ObjectId(owner.id),
    publicId: `unichat/test/asset-${++n}-${Math.random()}`, url: 'x', originalName: 'f.pdf', mimeType: 'application/pdf', type: 'document', size: 10, resourceType: 'raw', accessMode: 'authenticated',
    status: 'staged', message: null, assetDeleted: false, cleanupAttempts: 0, nextCleanupAt: null, createdAt: old, updatedAt: old, ...extra,
  })).insertedId;
  const calls = []; const destroy = async (publicId) => { calls.push(publicId); };
  const row = (id) => StoredAttachment.findById(id).lean();

  // 1. Stale unattached uploads are removed; fresh ones and attached ones are not.
  const stale = await make(); const fresh = await make({ createdAt: new Date(), updatedAt: new Date() }); const attached = await make({ status: 'attached' });
  const first = await cleanupOrphanedAttachments({ destroy });
  assert.equal(first.deleted, 1);
  assert.equal((await row(stale)).status, 'deleted'); assert.equal((await row(stale)).assetDeleted, true);
  assert.equal((await row(fresh)).status, 'staged'); assert.equal((await row(attached)).status, 'attached');
  assert.deepEqual(calls, [(await row(stale)).publicId]);
  console.log('ok - only stale unattached uploads are removed');

  // 2. Crash safety: a message references a still-"staged" upload (the attach write was lost). Repair, never delete.
  const lost = await make();
  const message = await Message.create({ workspace: W._id, channel: general._id, sender: owner.id, content: 'has file', attachments: [{ uploadId: lost, type: 'document', url: 'x', name: 'f.pdf' }] });
  calls.length = 0;
  const repair = await cleanupOrphanedAttachments({ destroy });
  assert.equal(repair.repaired, 1); assert.equal(calls.length, 0, 'file behind a live message must not be destroyed');
  assert.equal((await row(lost)).status, 'attached'); assert.equal(String((await row(lost)).message), String(message._id));
  console.log('ok - a lost "attached" write is repaired instead of deleting an in-use file');

  // 3. Storage failures retry with backoff and give up loudly, never losing track of the file.
  const flaky = await make(); const failing = async () => { throw new Error('storage down'); };
  const t0 = new Date();
  assert.equal((await cleanupOrphanedAttachments({ destroy: failing, now: t0 })).deleted, 0);
  let r = await row(flaky);
  assert.equal(r.status, 'deleted'); assert.equal(r.assetDeleted, false); assert.equal(r.cleanupAttempts, 1); assert.ok(new Date(r.nextCleanupAt) > t0, 'next attempt is scheduled in the future');
  calls.length = 0;
  await cleanupOrphanedAttachments({ destroy, now: t0 });
  assert.equal(calls.length, 0, 'not retried before its backoff elapses');
  const later = new Date(t0.getTime() + 3 * 3600 * 1000);
  const retried = await cleanupOrphanedAttachments({ destroy, now: later });
  assert.equal(retried.retried, 1); r = await row(flaky); assert.equal(r.assetDeleted, true);
  const doomed = await make({ status: 'deleted', assetDeleted: false, cleanupAttempts: 7 });
  const abandoned = await cleanupOrphanedAttachments({ destroy: failing, now: later });
  assert.equal(abandoned.abandoned, 1); assert.equal((await row(doomed)).nextCleanupAt, null);
  assert.equal((await cleanupOrphanedAttachments({ destroy: failing, now: new Date(later.getTime() + 3600 * 1000) })).batches, 0, 'abandoned rows are no longer picked up');
  console.log('ok - failures back off, eventually give up, and are never silently dropped');

  // 4. Batching: thousands of stale rows are processed without loading them all at once.
  await StoredAttachment.collection.insertMany(Array.from({ length: 1200 }, () => ({ workspace: new mongoose.Types.ObjectId(W._id), uploadedBy: new mongoose.Types.ObjectId(owner.id), publicId: `bulk-${Math.random()}`, url: 'x', originalName: 'f', mimeType: 'application/pdf', type: 'document', size: 1, resourceType: 'raw', accessMode: 'authenticated', status: 'staged', assetDeleted: false, cleanupAttempts: 0, createdAt: old, updatedAt: old })));
  calls.length = 0;
  const bulk = await cleanupOrphanedAttachments({ destroy, batchSize: 100 });
  assert.equal(bulk.deleted, 1200); assert.equal(bulk.batches, 12); assert.equal(await StoredAttachment.countDocuments({ status: 'staged', createdAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }), 0);
  console.log('ok - 1,200 rows processed in 12 bounded batches');

  // 5. Only one instance runs at a time; a crashed holder's lease expires.
  await make();
  let inside = 0; let overlap = false; const slow = async () => { inside++; if (inside > 1) overlap = true; await sleep(300); inside--; };
  const [a, b] = await Promise.all([cleanupOrphanedAttachments({ destroy: slow }), cleanupOrphanedAttachments({ destroy: slow })]);
  assert.equal([a, b].filter((x) => x.skipped).length, 1, 'the second concurrent run is skipped'); assert.equal(overlap, false);
  await JobLock.updateOne({ name: 'attachment-cleanup' }, { owner: 'crashed-instance-1', lockedUntil: new Date(Date.now() + 60000) }, { upsert: true });
  assert.ok((await cleanupOrphanedAttachments({ destroy })).skipped, 'a live lease held by someone else blocks us');
  await JobLock.updateOne({ name: 'attachment-cleanup' }, { lockedUntil: new Date(Date.now() - 1000) });
  assert.equal((await cleanupOrphanedAttachments({ destroy })).skipped, undefined, 'an expired lease is taken over');
  const release = await acquireLease('other-job', 1000); assert.ok(release, 'lease acquired'); await release();
  console.log('ok - single-runner lease with crash takeover');

  // 6. Metrics.
  const health = await (await fetch(`http://127.0.0.1:${t.port}/health`)).json();
  assert.ok(health.cleanup.runs >= 1 && 'lastRunAt' in health.cleanup, 'cleanup metrics are exposed on /health');
  console.log('ok - cleanup metrics visible on /health');
});
