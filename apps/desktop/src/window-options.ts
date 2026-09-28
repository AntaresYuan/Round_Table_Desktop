import type { BrowserWindowConstructorOptions } from 'electron';

export const DESKTOP_SESSION_PARTITION = 'roundtable-app';

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#111318',
    webPreferences: {
      preload: preloadPath,
      partition: DESKTOP_SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      webviewTag: false,
    },
  };
}
