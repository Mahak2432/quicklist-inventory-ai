// Build step for this app. There is no bundler: the server runs as plain
// JavaScript and the browser loads the files as they are. So "build" checks
// that every JavaScript file parses. Run the tests separately with npm test.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const folders = ['src', 'public', 'scripts', 'test'];

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

const files = folders.flatMap((folder) => jsFiles(join(root, folder)));
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`Syntax error in ${file}\n${result.stderr}`);
  }
}

if (failed) {
  console.error(`Build failed: ${failed} file(s) do not parse.`);
  process.exit(1);
}
console.log(`Build ok: ${files.length} JavaScript files parse.`);
