// Runs every self-contained integration test in its own process against its own throwaway database.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const tests = process.argv.slice(2).length ? process.argv.slice(2) : [
  'seed-guard', 'socket-isolation', 'message-integrity', 'attachments', 'pagination-sync', 'session-recovery',
  'push-devices', 'idempotency', 'recovery-security', 'membership', 'saved-messages', 'notifications-perf',
  'redis-resilience', 'uploads', 'cleanup', 'validation', 'socket-security', 'multi-instance', 'rate-limits', 'data-model', 'workspace-join', 'prod-config',
].filter((name) => require('node:fs').existsSync(path.join(__dirname, `${name}.test.js`)));
let failed = 0;
for (const name of tests) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(__dirname, `${name}.test.js`)], { encoding: 'utf8', timeout: 300000 });
  const ok = result.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) console.log((result.stdout + result.stderr).split('\n').filter((l) => !/^(POST|GET|PUT|PATCH|DELETE) /.test(l)).slice(-25).join('\n'));
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nAll ${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
