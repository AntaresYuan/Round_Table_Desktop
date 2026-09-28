import { describe, expect, it } from 'vitest';

import { createWindowOptions } from '../src/window-options.js';

describe('desktop BrowserWindow security', () => {
  it('keeps the renderer isolated without starting Electron', () => {
    const options = createWindowOptions('/tmp/roundtable-preload.cjs');

    expect(options.webPreferences).toMatchObject({
      preload: '/tmp/roundtable-preload.cjs',
      partition: 'roundtable-app',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      webviewTag: false,
    });
  });
});
