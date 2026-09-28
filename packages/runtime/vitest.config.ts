import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // launchd coalition jobs and their bounded fault-injection deadlines share
    // one per-user service domain. Serializing files on macOS prevents an
    // unrelated integration worker from starving a READY/cleanup handshake.
    fileParallelism: process.platform !== 'darwin',
    testTimeout: 30_000,
  },
});
