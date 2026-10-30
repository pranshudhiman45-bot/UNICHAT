const StarredMessage = require('../models/StarredMessage');
const SavedMessage = require('../models/SavedMessage');

// Idempotent: copies legacy "starred" rows into the unified saved collection. Safe to run on every start.
async function migrateStarredToSaved() {
  let migrated = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const result = await SavedMessage.bulkWrite(batch, { ordered: false, timestamps: false }); // keep the original star times
    migrated += result.upsertedCount || 0;
    batch = [];
  };
  for await (const row of StarredMessage.find().lean().cursor()) {
    batch.push({ updateOne: {
      filter: { user: row.user, message: row.message },
      update: { $setOnInsert: { user: row.user, message: row.message, workspace: row.workspace, channel: row.channel || null, dm: row.dm || null, createdAt: row.createdAt, updatedAt: row.updatedAt } },
      upsert: true,
    } });
    if (batch.length >= 500) await flush();
  }
  await flush();
  return migrated;
}
module.exports = { migrateStarredToSaved };
