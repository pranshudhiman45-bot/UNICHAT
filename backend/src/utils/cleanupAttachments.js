const StoredAttachment = require('../models/StoredAttachment');
const Message = require('../models/Message');
const fileStorage = require('../services/fileStorage');
const { acquireLease } = require('../services/jobLock');

const BATCH_SIZE = 200;
const MAX_BATCHES_PER_RUN = 25;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60 * 1000;
const stats = { runs: 0, lastRunAt: null, lastDurationMs: 0, deleted: 0, repaired: 0, retried: 0, abandoned: 0, lastError: null };

const backoffMs = (attempts) => Math.min(60 * 1000 * 2 ** attempts, 6 * 3600 * 1000);
const deliveryOf = (record) => (record.accessMode === 'authenticated' ? 'authenticated' : 'upload');

// Two kinds of work, both safe to repeat and safe to crash in the middle of:
//  1. staged uploads nobody attached within `ageHours`  -> delete the stored file
//     (unless a message already references it, which means the "attached" write was lost: repair instead)
//  2. attachments whose message was deleted but whose stored file could not be removed -> retry with backoff
async function cleanupOrphanedAttachments({ ageHours = 24, destroy = fileStorage.destroyAsset, now = new Date(), batchSize = BATCH_SIZE } = {}) {
  const release = await acquireLease('attachment-cleanup', LEASE_MS);
  if (!release) return { skipped: 'another instance is running cleanup' };
  const started = Date.now();
  const summary = { deleted: 0, repaired: 0, retried: 0, abandoned: 0, batches: 0 };
  try {
    const cutoff = new Date(now.getTime() - ageHours * 3600 * 1000);
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const records = await StoredAttachment.find({ $or: [
        { status: 'staged', createdAt: { $lt: cutoff } },
        { status: 'deleted', assetDeleted: false, cleanupAttempts: { $lt: MAX_ATTEMPTS }, $or: [{ nextCleanupAt: null }, { nextCleanupAt: { $lte: now } }] },
      ] }).sort({ createdAt: 1 }).limit(batchSize);
      if (!records.length) break;
      summary.batches++;

      // Never delete a file a live message still points at.
      const staged = records.filter((record) => record.status === 'staged');
      const referenced = staged.length
        ? await Message.find({ 'attachments.uploadId': { $in: staged.map((record) => record._id) }, isDeleted: false }).select('_id attachments.uploadId').lean()
        : [];
      const owner = new Map();
      for (const message of referenced) for (const attachment of message.attachments) if (attachment.uploadId) owner.set(String(attachment.uploadId), message._id);

      let progressed = 0;
      await Promise.all(records.map(async (record) => {
        if (record.status === 'staged' && owner.has(String(record._id))) {
          await StoredAttachment.updateOne({ _id: record._id, status: 'staged' }, { $set: { status: 'attached', message: owner.get(String(record._id)) } });
          summary.repaired++; progressed++; return;
        }
        try {
          await destroy(record.publicId, record.resourceType, deliveryOf(record));
          await StoredAttachment.updateOne({ _id: record._id }, { $set: { status: 'deleted', assetDeleted: true, nextCleanupAt: null } });
          summary[record.status === 'staged' ? 'deleted' : 'retried']++; progressed++;
        } catch (error) {
          const attempts = (record.cleanupAttempts || 0) + 1;
          const abandoned = attempts >= MAX_ATTEMPTS;
          await StoredAttachment.updateOne({ _id: record._id }, { $set: { status: 'deleted', assetDeleted: false, cleanupAttempts: attempts, nextCleanupAt: abandoned ? null : new Date(now.getTime() + backoffMs(attempts)) } });
          if (abandoned) { summary.abandoned++; console.error(`Attachment ${record._id} could not be removed from storage after ${attempts} attempts; manual cleanup needed (${error.message})`); }
          else console.warn(`Attachment cleanup failed (attempt ${attempts}), will retry later: ${error.message}`);
        }
      }));
      if (!progressed && records.length < batchSize) break;
    }
    stats.runs++; stats.lastRunAt = new Date().toISOString(); stats.lastDurationMs = Date.now() - started; stats.lastError = null;
    for (const key of ['deleted', 'repaired', 'retried', 'abandoned']) stats[key] += summary[key];
    if (summary.deleted || summary.repaired || summary.retried || summary.abandoned) console.log(`Attachment cleanup: ${JSON.stringify(summary)} in ${stats.lastDurationMs}ms`);
    return summary;
  } catch (error) {
    stats.lastError = error.message;
    throw error;
  } finally {
    await release();
  }
}

// Runs periodically on every instance; the lease ensures only one does the work at a time.
function startCleanupScheduler({ intervalMinutes = Number(process.env.CLEANUP_INTERVAL_MINUTES ?? 15) } = {}) {
  if (!intervalMinutes || intervalMinutes <= 0) return () => undefined;
  const run = () => cleanupOrphanedAttachments().catch((error) => console.error('Attachment cleanup failed:', error.message));
  const timer = setInterval(run, intervalMinutes * 60 * 1000 + Math.floor(Math.random() * 5000));
  timer.unref();
  return () => clearInterval(timer);
}

const cleanupStats = () => ({ ...stats });
module.exports = { cleanupOrphanedAttachments, startCleanupScheduler, cleanupStats };
