import type { DesktopBridge } from '@roundtable/protocol';

declare global {
  interface Window {
    roundtableDesktop: DesktopBridge;
  }
}

export {};
