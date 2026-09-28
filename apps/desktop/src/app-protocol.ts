import { net, protocol, type Protocol } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_SCHEME = 'roundtable';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const rendererAssets = createRendererAssetMap(moduleDirectory);

export function createRendererAssetMap(runtimeDirectory: string): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ['/index.html', join(runtimeDirectory, '../renderer/index.html')],
    ['/styles.css', join(runtimeDirectory, '../renderer/styles.css')],
    ['/renderer.js', join(runtimeDirectory, 'renderer.js')],
  ]);
}

export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      bypassCSP: false,
      allowServiceWorkers: false,
    },
  }]);
}

export async function registerAppProtocol(
  protocolRegistry: Pick<Protocol, 'handle'> = protocol,
): Promise<void> {
  await protocolRegistry.handle(APP_SCHEME, handleAppProtocolRequest);
}

export async function handleAppProtocolRequest(
  request: Pick<Request, 'method' | 'url'>,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return secureResponse('Method not allowed', 405, 'text/plain; charset=utf-8', {
      allow: 'GET, HEAD',
    });
  }

  const assetPath = assetPathForUrl(request.url);
  if (!assetPath) {
    return secureResponse('Not found', 404, 'text/plain; charset=utf-8');
  }

  try {
    const source = await net.fetch(pathToFileURL(assetPath).toString());
    if (!source.ok || !source.body) {
      return secureResponse('Not found', 404, 'text/plain; charset=utf-8');
    }

    return secureResponse(
      request.method === 'HEAD' ? null : source.body,
      200,
      contentTypeForPath(assetPath),
    );
  } catch {
    return secureResponse('Not found', 404, 'text/plain; charset=utf-8');
  }
}

export function assetPathForUrl(
  rawUrl: string,
  assets: ReadonlyMap<string, string> = rendererAssets,
): string | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== `${APP_SCHEME}:`
      || url.host !== 'app'
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) return null;

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    return assets.get(pathname) ?? null;
  } catch {
    return null;
  }
}

export function isTrustedAppDocumentUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${APP_SCHEME}:`
      && url.host === 'app'
      && url.pathname === '/index.html'
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

export function isAllowedFrameNavigation(rawUrl: string, isMainFrame: boolean): boolean {
  return isMainFrame && isTrustedAppDocumentUrl(rawUrl);
}

function contentTypeForPath(assetPath: string): string {
  if (assetPath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (assetPath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (assetPath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function secureResponse(
  body: BodyInit | null,
  status: number,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': APP_CONTENT_SECURITY_POLICY,
      'content-type': contentType,
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}
