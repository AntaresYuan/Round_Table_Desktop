import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const electronMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  net: { fetch: electronMocks.fetch },
  protocol: {
    handle: electronMocks.handle,
    registerSchemesAsPrivileged: vi.fn(),
  },
}));

const {
  assetPathForUrl,
  createRendererAssetMap,
  handleAppProtocolRequest,
  isAllowedFrameNavigation,
  isTrustedAppDocumentUrl,
  registerAppProtocol,
} = await import('../src/app-protocol.js');
const runtimeDirectory = join('/bundle', 'dist');
const rendererAssets = createRendererAssetMap(runtimeDirectory);

beforeEach(() => {
  electronMocks.fetch.mockReset();
  electronMocks.handle.mockReset();
});

describe('desktop app protocol', () => {
  it('registers the handler on the supplied isolated session protocol', async () => {
    const isolatedHandle = vi.fn();
    await registerAppProtocol({ handle: isolatedHandle } as never);

    expect(isolatedHandle).toHaveBeenCalledWith('roundtable', handleAppProtocolRequest);
    expect(electronMocks.handle).not.toHaveBeenCalled();
  });

  it('serves only the explicit renderer asset allowlist', () => {
    expect(assetPathForUrl('roundtable://app/', rendererAssets)).toBe(
      join('/bundle', 'renderer', 'index.html'),
    );
    expect(assetPathForUrl('roundtable://app/styles.css', rendererAssets)).toBe(
      join('/bundle', 'renderer', 'styles.css'),
    );
    expect(assetPathForUrl('roundtable://app/renderer.js', rendererAssets)).toBe(
      join('/bundle', 'dist', 'renderer.js'),
    );
  });

  it('rejects foreign origins and unknown or traversal paths', () => {
    expect(assetPathForUrl('https://app/index.html', rendererAssets)).toBeNull();
    expect(assetPathForUrl('roundtable://evil/index.html', rendererAssets)).toBeNull();
    expect(assetPathForUrl('roundtable://app.evil/index.html', rendererAssets)).toBeNull();
    expect(assetPathForUrl('roundtable://app/index.html?asset=1', rendererAssets)).toBeNull();
    expect(assetPathForUrl('roundtable://app/index.html#asset', rendererAssets)).toBeNull();
    expect(assetPathForUrl('roundtable://app/../../etc/passwd', rendererAssets)).toBeNull();
    expect(assetPathForUrl('roundtable://app/not-declared.js', rendererAssets)).toBeNull();
    expect(assetPathForUrl('not a url', rendererAssets)).toBeNull();
  });

  it('trusts only the exact main document in the main frame', () => {
    expect(isTrustedAppDocumentUrl('roundtable://app/index.html')).toBe(true);
    expect(isAllowedFrameNavigation('roundtable://app/index.html', true)).toBe(true);

    for (const rawUrl of [
      'roundtable://app/',
      'roundtable://app.evil/index.html',
      'roundtable://app/index.html.evil',
      'roundtable://app/index.html?next=1',
      'roundtable://app/index.html#next',
      'https://app/index.html',
      'not a url',
    ]) {
      expect(isTrustedAppDocumentUrl(rawUrl)).toBe(false);
    }
    expect(isAllowedFrameNavigation('roundtable://app/index.html', false)).toBe(false);
  });

  it('serves assets with response security headers and explicit content types', async () => {
    electronMocks.fetch.mockResolvedValue(new Response('console.log("ok")', { status: 200 }));

    const response = await handleAppProtocolRequest({
      method: 'GET',
      url: 'roundtable://app/renderer.js',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('console.log("ok")');
  });

  it('rejects unsupported methods before touching the filesystem', async () => {
    const response = await handleAppProtocolRequest({
      method: 'POST',
      url: 'roundtable://app/index.html',
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(electronMocks.fetch).not.toHaveBeenCalled();
  });
});
