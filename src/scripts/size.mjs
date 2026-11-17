import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIMIT_KB = 400;
const dir = join(import.meta.dirname, '..', 'dist', 'assets');
const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
if (files.length === 0) throw new Error(`no .js files in ${dir}; run pnpm --filter @agent-works/floor build`);
let total = 0;
for (const name of files) {
  const gz = gzipSync(readFileSync(join(dir, name))).length;
  total += gz;
  console.log(`${name}: ${(gz / 1024).toFixed(1)} KB gzipped`);
}
const kb = total / 1024;
console.log(`total gzipped JS: ${kb.toFixed(1)} KB, limit ${LIMIT_KB} KB`);
if (kb > LIMIT_KB) {
  console.error('FAIL: bundle over the limit');
  process.exit(1);
}
