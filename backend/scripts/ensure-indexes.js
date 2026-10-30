// Creates any missing indexes without dropping existing ones (non-destructive, safe on a live database).
// Run after deploying a release that adds indexes:  npm run db:indexes
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false });
  const dir = path.join(__dirname, '../src/models');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    const model = require(path.join(dir, file));
    const started = Date.now();
    await model.createIndexes();
    console.log(`${model.modelName}: indexes ensured (${Date.now() - started} ms)`);
  }
  await mongoose.disconnect();
})().catch((error) => { console.error('Index creation failed:', error.message); process.exit(1); });
