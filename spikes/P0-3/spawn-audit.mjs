import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const file = process.env.SPAWN_AUDIT_FILE;
const cp = /** @type {Record<string, (...args: unknown[]) => unknown>} */ (
  createRequire(import.meta.url)('node:child_process')
);

for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  const original = cp[name];
  if (typeof original !== 'function' || !file) continue;
  cp[name] = (...args) => {
    appendFileSync(file, `${name} ${JSON.stringify(args[0])}\n`);
    return original(...args);
  };
}
syncBuiltinESMExports();
