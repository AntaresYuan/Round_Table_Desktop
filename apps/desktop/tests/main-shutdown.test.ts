import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    enableSandbox: vi.fn(),
    getPath: vi.fn(() => '/tmp/roundtable-main-test'),
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));
vi.mock('../src/app-protocol.js', () => ({
  APP_ORIGIN: 'app://roundtable',
  registerAppProtocol: vi.fn(),
  registerAppSchemePrivileges: vi.fn(),
}));
vi.mock('../src/desktop-session.js', () => ({ secureDesktopSession: vi.fn() }));
vi.mock('../src/execution-authority.js', () => ({
  DesktopExecutionAuthority: class {},
}));
vi.mock('../src/ipc-handlers.js', () => ({ registerDesktopIpcHandlers: vi.fn() }));
vi.mock('../src/utility-agent-runtime.js', () => ({ UtilityAgentRuntime: class {} }));
vi.mock('../src/utility-directory-reader.js', () => ({
  createUtilityDirectoryReader: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock('../src/window-lifecycle.js', () => ({ secureDesktopWindowLifecycle: vi.fn() }));
vi.mock('../src/window-options.js', () => ({
  createWindowOptions: vi.fn(),
  DESKTOP_SESSION_PARTITION: 'persist:roundtable-test',
}));
vi.mock('../src/workspace-grants.js', () => ({
  WorkspaceGrantRegistry: class {},
}));

import { createDesktopQuitCoordinator } from '../src/main.mjs';

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop quit coordinator', () => {
  it('keeps every quit request prevented until cleanup succeeds and permits a retry after failure', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const shutdown = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const quit = vi.fn();
    const onFailure = vi.fn();
    const coordinate = createDesktopQuitCoordinator({
      shutdown,
      quit,
      onFailure,
      timeoutMs: 30_000,
    });
    const firstEvent = { preventDefault: vi.fn() };
    const concurrentEvent = { preventDefault: vi.fn() };

    coordinate(firstEvent);
    coordinate(concurrentEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(concurrentEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    first.reject(new Error('runtime_shutdown_unconfirmed'));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(quit).not.toHaveBeenCalled();

    const retryEvent = { preventDefault: vi.fn() };
    coordinate(retryEvent);
    expect(retryEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(2);
    second.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));

    const confirmedEvent = { preventDefault: vi.fn() };
    coordinate(confirmedEvent);
    expect(confirmedEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('does not quit after the cleanup deadline and returns to a retryable locked state', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(() => new Promise<void>(() => undefined));
    const quit = vi.fn();
    const onFailure = vi.fn();
    const coordinate = createDesktopQuitCoordinator({
      shutdown,
      quit,
      onFailure,
      timeoutMs: 25,
    });
    const firstEvent = { preventDefault: vi.fn() };

    coordinate(firstEvent);
    await vi.advanceTimersByTimeAsync(25);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    const retryEvent = { preventDefault: vi.fn() };
    coordinate(retryEvent);
    expect(retryEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(quit).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
