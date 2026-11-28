import { defineConfig } from 'vitest/config';

// These limits catch hangs, not slow code. A CI runner can stall for many seconds: tests that
// normally take under 0.3 s have taken 13 to 29 s there (#86). Do not raise the limit of one
// test for a stall. A limit above this one is for work that is slow on every run.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/setup/sync-children.ts'],
  },
});
