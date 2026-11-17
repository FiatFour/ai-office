import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = String(process.argv[2]);
const [startAt = 0, trials = 0, gap = 0] = process.argv.slice(3, 6).map(Number);
const { Store } = await import(fileURLToPath(new URL('../store/store.ts', import.meta.url)));
const held = [];
for (let trial = 0; trial < trials; trial += 1) {
  const at = startAt + trial * gap;
  while (Date.now() < at);
  try {
    held.push(Store.open(join(base, `t${trial}`)));
    console.log(`${trial} OPEN`);
  } catch {
    console.log(`${trial} REFUSED`);
  }
}
console.log('DONE');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
