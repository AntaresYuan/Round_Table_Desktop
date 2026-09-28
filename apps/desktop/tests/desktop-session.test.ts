import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { secureDesktopSession } from '../src/desktop-session.js';

describe('desktop session security', () => {
  it('denies renderer permissions, devices, and external network schemes', () => {
    const onBeforeRequest = vi.fn();
    const desktopSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      webRequest: { onBeforeRequest },
    } as unknown as Session;

    secureDesktopSession(desktopSession);

    const permissionCheck = vi.mocked(desktopSession.setPermissionCheckHandler).mock.calls[0]?.[0];
    expect(permissionCheck?.(null, 'geolocation', 'roundtable://app', {} as never)).toBe(false);

    const permissionRequest = vi.mocked(desktopSession.setPermissionRequestHandler).mock
      .calls[0]?.[0];
    const permissionCallback = vi.fn();
    permissionRequest?.({} as never, 'notifications', permissionCallback, {} as never);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const devicePermission = vi.mocked(desktopSession.setDevicePermissionHandler).mock
      .calls[0]?.[0];
    expect(devicePermission?.({} as never)).toBe(false);

    const [filter, listener] = onBeforeRequest.mock.calls[0] as [
      { urls: string[] },
      (_details: unknown, callback: (response: { cancel: boolean }) => void) => void,
    ];
    expect(filter.urls).toEqual(expect.arrayContaining([
      'http://*/*',
      'https://*/*',
      'file://*/*',
    ]));
    const networkCallback = vi.fn();
    listener({}, networkCallback);
    expect(networkCallback).toHaveBeenCalledWith({ cancel: true });
  });
});
