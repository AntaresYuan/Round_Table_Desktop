import { EventEmitter } from 'node:events';

import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { secureDesktopWindowLifecycle } from '../src/window-lifecycle.js';

class FakeWebContents extends EventEmitter {
  readonly id = 42;
  readonly mainFrame = { url: 'roundtable://app/index.html' };
  readonly setWindowOpenHandler = vi.fn();
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function navigationDetails(url: string, isMainFrame: boolean) {
  return {
    url,
    isMainFrame,
    isSameDocument: false,
    preventDefault: vi.fn(),
  };
}

describe('desktop window lifecycle', () => {
  it('denies new windows, foreign navigation, and every subframe navigation', () => {
    const window = new FakeWindow();
    const grants = { revokeOwner: vi.fn() };
    secureDesktopWindowLifecycle(
      window as unknown as BrowserWindow,
      grants,
    );

    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' });

    const trustedMainFrame = navigationDetails('roundtable://app/index.html', true);
    window.webContents.emit('will-frame-navigate', trustedMainFrame);
    expect(trustedMainFrame.preventDefault).not.toHaveBeenCalled();

    for (const details of [
      navigationDetails('https://evil.example/', true),
      navigationDetails('roundtable://app.evil/index.html', true),
      navigationDetails('roundtable://app/index.html', false),
    ]) {
      window.webContents.emit('will-frame-navigate', details);
      expect(details.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('revokes owner capabilities on full navigation and window teardown', () => {
    const window = new FakeWindow();
    const grants = { revokeOwner: vi.fn() };
    const ownerId = secureDesktopWindowLifecycle(
      window as unknown as BrowserWindow,
      grants,
    );

    expect(ownerId).toBe(42);
    window.webContents.emit('did-start-navigation', navigationDetails(
      'roundtable://app/index.html',
      true,
    ));
    window.webContents.emit('destroyed');
    window.emit('closed');

    expect(grants.revokeOwner).toHaveBeenCalledTimes(3);
    expect(grants.revokeOwner).toHaveBeenCalledWith(42);
  });

  it('settles a renderer failure once, revokes capabilities, and destroys the window', () => {
    const window = new FakeWindow();
    const grants = { revokeOwner: vi.fn() };
    const onFailure = vi.fn();
    secureDesktopWindowLifecycle(
      window as unknown as BrowserWindow,
      grants,
      { onFailure },
    );

    window.webContents.emit('preload-error', {}, '/preload.cjs', new Error('boom'));
    window.webContents.emit('unresponsive');

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith('renderer_preload_failed');
    expect(grants.revokeOwner).toHaveBeenCalledOnce();
    expect(window.destroy).toHaveBeenCalledOnce();
  });
});
