import { readData, type RoundtableData } from '../../store.js';
import { A2AUnavailableError } from './errors.js';
import type { A2ARemoteAgentConfig } from '../../types.js';
import { AGENT_ROSTER } from '../agent-roster.js';

export type ResolvedA2ARemoteAgentConfig = {
  agentId: string;
  enabled: boolean;
  baseUrl: string;
  cardPath: string | null;
  authToken: string | null;
  source: 'settings' | 'env';
};

export async function resolveA2ARemoteAgentConfig(
  agentId: string,
  data?: RoundtableData,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedA2ARemoteAgentConfig | null> {
  if (!AGENT_ROSTER.some((agent) => agent.id === agentId)) return null;
  const current = data ?? await readData();
  const stored = current.settings.a2aRemoteAgents.find((item) => item.agentId === agentId) ?? null;
  const key = agentId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  if (stored) return storedConfig(stored, clean(env[`ROUNDTABLE_A2A_TOKEN_${key}`]) ?? null);

  const baseUrl = clean(env[`ROUNDTABLE_A2A_URL_${key}`]);
  if (!baseUrl) return null;
  return {
    agentId,
    enabled: true,
    baseUrl: assertAllowedA2AUrl(baseUrl, env.NODE_ENV),
    cardPath: clean(env[`ROUNDTABLE_A2A_CARD_PATH_${key}`]) ?? '/.well-known/agent-card.json',
    authToken: clean(env[`ROUNDTABLE_A2A_TOKEN_${key}`]) ?? null,
    source: 'env',
  };
}

export function assertAllowedA2AUrl(raw: string, nodeEnv: string | undefined): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Must be an adapter error: a bad stored URL has to degrade to
    // local-dispatch, not take the whole turn down with it.
    throw new A2AUnavailableError('a2a_invalid_url');
  }
  if (url.protocol !== 'https:' && !(nodeEnv !== 'production' && url.protocol === 'http:' && isLoopback(url))) {
    throw new A2AUnavailableError('a2a_https_required');
  }
  return url.toString().replace(/\/$/, '');
}

// WHATWG URL keeps the brackets on IPv6 hosts (`http://[::1]:41241` parses to
// hostname `'[::1]'`), so a bare '::1' in an allowlist never matches. Compare
// on the unbracketed form and accept the whole 127/8 loopback block.
export function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    ?? /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 ? v4[1] === '127' : false;
}

function storedConfig(
  config: A2ARemoteAgentConfig,
  envToken: string | null,
): ResolvedA2ARemoteAgentConfig {
  return {
    agentId: config.agentId,
    enabled: config.enabled,
    baseUrl: config.baseUrl ? assertAllowedA2AUrl(config.baseUrl, process.env.NODE_ENV) : '',
    cardPath: config.cardPath,
    authToken: config.authToken || envToken,
    source: 'settings',
  };
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
