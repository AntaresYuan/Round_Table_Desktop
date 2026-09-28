import type { BrowserWindow } from 'electron';

import { isAllowedFrameNavigation } from './app-protocol.js';

export type DesktopWindowFailure =
  | 'renderer_load_failed'
  | 'renderer_preload_failed'
  | 'renderer_process_gone'
  | 'renderer_unresponsive';

type WindowLifecycleOptions = {
  onCapabilitiesRevoked?(ownerId: number): void;
  onFailure?(failure: DesktopWindowFailure): void;
};

type RevocableWorkspaceGrants = {
  revokeOwner(ownerId: number): void;
};

export function secureDesktopWindowLifecycle(
  window: BrowserWindow,
  grants: RevocableWorkspaceGrants,
  options: WindowLifecycleOptions = {},
): number {
  const ownerId = window.webContents.id;
  let failed = false;

  const revokeCapabilities = () => {
    grants.revokeOwner(ownerId);
    options.onCapabilitiesRevoked?.(ownerId);
  };
  const terminateFailedWindow = (failure: DesktopWindowFailure) => {
    if (failed) return;
    failed = true;
    revokeCapabilities();
    options.onFailure?.(failure);
    if (!window.isDestroyed()) window.destroy();
  };

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (details) => {
    if (!isAllowedFrameNavigation(details.url, details.isMainFrame)) {
      details.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (details) => {
    if (!isAllowedFrameNavigation(details.url, details.isMainFrame)) {
      details.preventDefault();
    }
  });
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) revokeCapabilities();
  });
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) terminateFailedWindow('renderer_load_failed');
  });
  window.webContents.on('preload-error', () => {
    terminateFailedWindow('renderer_preload_failed');
  });
  window.webContents.on('render-process-gone', () => {
    terminateFailedWindow('renderer_process_gone');
  });
  window.webContents.on('unresponsive', () => {
    terminateFailedWindow('renderer_unresponsive');
  });
  window.webContents.once('destroyed', revokeCapabilities);
  window.once('closed', revokeCapabilities);

  return ownerId;
}
