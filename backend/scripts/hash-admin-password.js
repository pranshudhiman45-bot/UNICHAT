const bcrypt = require('bcryptjs');

function readHidden(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return reject(new Error('Run this script in an interactive terminal'));
    let value = '';
    process.stdout.write(`${label} (input hidden): `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

(async () => {
  const first = await readHidden('Admin password');
  const second = await readHidden('Confirm password');
  if (first !== second) throw new Error('Passwords do not match');
  if (first.length < 12) throw new Error('Use at least 12 characters for the administrator password');
  console.log(`ADMIN_PASSWORD_HASH=${await bcrypt.hash(first, 12)}`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
