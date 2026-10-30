const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { assertSeedAllowed } = require('../src/utils/seedGuard');
const good = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://127.0.0.1:27017/dev' };
const flag = ['--confirm-destroy-all-data'];
assert.doesNotThrow(() => assertSeedAllowed({ env: good, argv: flag }));
assert.throws(() => assertSeedAllowed({ env: { ...good, NODE_ENV: 'production' }, argv: flag }), /NODE_ENV=production/);
assert.throws(() => assertSeedAllowed({ env: { ...good, NODE_ENV: undefined }, argv: flag }), /explicitly/);
assert.throws(() => assertSeedAllowed({ env: good, argv: [] }), /--confirm-destroy-all-data/);
assert.throws(() => assertSeedAllowed({ env: { ...good, MONGODB_URI: 'mongodb+srv://u:p@cluster.mongodb.net/prod' }, argv: flag }), /not a local database/);
assert.throws(() => assertSeedAllowed({ env: { ...good, MONGODB_URI: 'mongodb://evil.example.com/x' }, argv: flag }), /not a local database/);
// End to end: the real script must exit non-zero in production without touching the database.
let blocked = false;
try {
  execFileSync(process.execPath, [path.join(__dirname, '../src/utils/seed.js'), '--confirm-destroy-all-data'], { env: { ...process.env, NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/never-connected' }, stdio: 'pipe', timeout: 15000 });
} catch (error) { blocked = /Seed refused/.test(String(error.stderr)); }
assert.ok(blocked, 'seed.js must refuse to run in production');
console.log('seed guard tests passed');
