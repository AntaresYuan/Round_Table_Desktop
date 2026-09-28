import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn one node CLI fixture per task; under full-suite
    // CPU contention the vitest default (5s) flakes on whichever test lands on
    // a busy core. Generous wall-clock budget, not slower tests.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
