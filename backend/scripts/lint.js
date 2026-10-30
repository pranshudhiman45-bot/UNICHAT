// No ESLint is configured in this repository. This is a minimal gate: every backend source and script file must
// parse, and no file may contain a leftover debugger statement or an accidental focused test.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (/\.(c?js)$/.test(entry.name)) files.push(full);
  }
})(root);
let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) { failed++; console.error(`Syntax error in ${path.relative(root, file)}:\n${String(error.stderr).split('\n').slice(0, 4).join('\n')}`); }
  const text = fs.readFileSync(file, 'utf8');
  if (/^\s*debugger;?\s*$/m.test(text)) { failed++; console.error(`debugger statement in ${path.relative(root, file)}`); }
  if (/\b(?:it|test|describe)\.only\(/.test(text)) { failed++; console.error(`.only() in ${path.relative(root, file)}`); }
}
console.log(failed ? `${failed} problem(s) in ${files.length} files` : `Lint OK: ${files.length} backend files parse cleanly`);
process.exit(failed ? 1 : 0);
