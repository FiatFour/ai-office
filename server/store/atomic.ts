import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 20;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

export const writeDurable = (path: string, data: string): void => {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const appendDurable = (path: string, data: string): void => {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const writeAtomic = (path: string, data: string): void => {
  const temp = `${path}.${process.pid}.tmp`;
  writeDurable(temp, data);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RETRY_CODES.has(code) || attempt >= RETRIES) {
        try {
          unlinkSync(temp);
        } catch {}
        throw error;
      }
      sleepSync(5 * (attempt + 1));
    }
  }
};
