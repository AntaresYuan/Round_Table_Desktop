import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: { fork: electronMocks.fork },
}));

const { createUtilityDirectoryReader } = await import('../src/utility-directory-reader.js');

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
}

beforeEach(() => {
  electronMocks.fork.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('utility directory reader', () => {
  it('uses a one-shot utility process with a fixed minimal environment', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child);
    const reader = createUtilityDirectoryReader('/bundle/directory-reader-child.mjs');
    const snapshot = {
      canonicalPath: '/workspace',
      device: '1',
      inode: '2',
      entries: [{ name: 'src', kind: 'directory' as const }],
      truncated: false,
    };

    const resultPromise = reader('/workspace');
    queueMicrotask(() => child.emit('message', { ok: true, snapshot }));

    await expect(resultPromise).resolves.toEqual(snapshot);
    expect(electronMocks.fork).toHaveBeenCalledWith(
      '/bundle/directory-reader-child.mjs',
      [],
      expect.objectContaining({
        cwd: '/workspace',
        env: { LANG: 'C', LC_ALL: 'C' },
        stdio: 'ignore',
      }),
    );
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('converts malformed child messages to a stable capability error', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child);
    const reader = createUtilityDirectoryReader('/bundle/directory-reader-child.mjs');

    const resultPromise = reader('/workspace');
    queueMicrotask(() => child.emit('message', { ok: true, snapshot: null }));

    await expect(resultPromise).rejects.toThrow('workspace_directory_unavailable');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('kills a child that spawns after its request has timed out', async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    child.kill.mockReturnValueOnce(false).mockReturnValue(true);
    electronMocks.fork.mockReturnValue(child);
    const reader = createUtilityDirectoryReader('/bundle/directory-reader-child.mjs');

    const resultPromise = reader('/workspace');
    const rejection = expect(resultPromise).rejects.toThrow('workspace_directory_unavailable');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();

    child.emit('spawn');
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.emit('exit', 0);
    reader.dispose();
  });

  it('disposes every active reader and rejects future reads', async () => {
    const child = new FakeUtilityProcess();
    electronMocks.fork.mockReturnValue(child);
    const reader = createUtilityDirectoryReader('/bundle/directory-reader-child.mjs');
    const activeRead = reader('/workspace');
    const activeRejection = expect(activeRead).rejects.toThrow(
      'workspace_directory_unavailable',
    );

    reader.dispose();
    await activeRejection;
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(reader('/workspace')).rejects.toThrow('workspace_directory_unavailable');
  });
});
