const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('../backend/node_modules/dotenv');
const root = path.resolve(__dirname, '..');
const processes = [];
function start(project, args) {
  const filename = path.join(root, project, '.env.test.local');
  if (!fs.existsSync(filename)) throw new Error('Run npm run setup:local first.');
  const env = { ...process.env, ...dotenv.parse(fs.readFileSync(filename)), ENV_FILE: '.env.test.local' };
  const child = spawn(process.execPath, args, { cwd: path.join(root, project), env, stdio: 'inherit' });
  processes.push(child);
  child.on('exit', (code, signal) => { if (!signal && code) { processes.forEach((other) => { if (other !== child) other.kill('SIGTERM'); }); process.exitCode = code; } });
}
{
  start('backend', ['--watch', 'src/index.js']);
  start('web', ['node_modules/vite/bin/vite.js', '--mode', 'test', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => processes.forEach((child) => child.kill(signal)));
