import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@roundtable/domain': new URL('../../packages/domain/src/index.ts', import.meta.url).pathname,
      '@roundtable/protocol': new URL('../../packages/protocol/src/index.ts', import.meta.url).pathname,
      '@roundtable/runtime': new URL('../../packages/runtime/src/index.ts', import.meta.url).pathname,
    },
  },
});
