// The seed script deletes every user, workspace and message. These checks are deliberately strict:
// every one of them must pass, and each refusal says exactly why.
function assertSeedAllowed({ env = process.env, argv = process.argv } = {}) {
  const problems = [];
  const mode = String(env.NODE_ENV || '').toLowerCase();
  const uri = env.MONGODB_URI || env.MONGO_URI || '';
  if (mode === 'production') problems.push('NODE_ENV=production');
  if (!['development', 'test'].includes(mode)) problems.push(`NODE_ENV must be explicitly "development" or "test" (got "${mode || 'unset'}")`);
  if (!/^mongodb:\/\/(?:[^@/]*@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(uri) && env.SEED_ALLOW_REMOTE !== 'true') {
    problems.push('MONGODB_URI is not a local database (set SEED_ALLOW_REMOTE=true only for a disposable non-production database)');
  }
  if (!argv.includes('--confirm-destroy-all-data')) problems.push('missing --confirm-destroy-all-data flag');
  if (problems.length) {
    const error = new Error(`Seed refused: ${problems.join('; ')}. No data was modified.`);
    error.code = 'SEED_BLOCKED';
    throw error;
  }
}
module.exports = { assertSeedAllowed };
