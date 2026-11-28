// A synchronous child holds the event loop, so the test timeout cannot end it and a hung one
// hangs the whole run. This gives each one without a timeout of its own a limit that kills it.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const limit = { ms: 60_000 };

type Options = { timeout?: number; killSignal?: NodeJS.Signals | number };
type Call = (...args: unknown[]) => unknown;

const limited =
  (real: Call, takesArgs: boolean): Call =>
  (command, ...rest) => {
    const at = takesArgs && (rest[0] == null || Array.isArray(rest[0])) ? 1 : 0;
    const given = rest[at] as Options | undefined;
    if (given?.timeout !== undefined) return real(command, ...rest);
    const args = [...rest];
    args[at] = { killSignal: 'SIGKILL', ...given, timeout: limit.ms };
    const result = real(command, ...args) as { error?: NodeJS.ErrnoException } | undefined;
    // spawnSync returns the timeout instead of throwing it, and a caller may not look.
    if (result?.error?.code === 'ETIMEDOUT') throw result.error;
    return result;
  };

// The mark also tells the test of this file that vitest loaded it, with no import to load it again.
const marked = Symbol.for('aw.syncChildLimit');
const target = childProcess as unknown as Record<string | symbol, unknown>;
if (target[marked] === undefined) {
  for (const name of ['execFileSync', 'spawnSync']) target[name] = limited(target[name] as Call, true);
  target.execSync = limited(target.execSync as Call, false);
  target[marked] = limit;
  syncBuiltinESMExports();
}
