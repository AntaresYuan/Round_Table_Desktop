import type { Session } from 'electron';

const RENDERER_NETWORK_URLS = [
  'http://*/*',
  'https://*/*',
  'ws://*/*',
  'wss://*/*',
  'file://*/*',
];

export function secureDesktopSession(desktopSession: Session): void {
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  desktopSession.setDevicePermissionHandler(() => false);
  desktopSession.webRequest.onBeforeRequest(
    { urls: RENDERER_NETWORK_URLS },
    (_details, callback) => callback({ cancel: true }),
  );
}
