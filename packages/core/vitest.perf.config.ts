import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['packages/core/test/*.perf.ts'], testTimeout: 600_000 },
});
