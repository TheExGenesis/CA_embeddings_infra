import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const runtimeClientHashSecret = randomBytes(32);

export type SearchClientType = 'browser' | 'api_client' | 'bot' | 'unknown';
export type SearchTrafficSource = 'same_site_ui' | 'external_referrer' | 'direct_api';

export interface SearchAttribution {
  clientHash: string;
  clientType: SearchClientType;
  trafficSource: SearchTrafficSource;
  originHost?: string;
  referrerHost?: string;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeHostname(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.hostname.toLowerCase().slice(0, 253);
  } catch {
    return undefined;
  }
}

function normalizeRequestHost(hostname: string): string {
  return hostname.toLowerCase().replace(/:\d+$/, '');
}

export function classifySearchClient(userAgent: string | undefined): SearchClientType {
  if (!userAgent) return 'unknown';

  if (/bot|crawler|spider|headless|uptime|monitor|probe/i.test(userAgent)) return 'bot';
  if (/curl|wget|python|postman|insomnia|axios|node|bun\/|go-http-client/i.test(userAgent)) return 'api_client';
  if (/mozilla\//i.test(userAgent)) return 'browser';
  return 'unknown';
}

export function createDailyClientHash(
  ip: string,
  userAgent: string | undefined,
  now: Date = new Date(),
  secret: Uint8Array = runtimeClientHashSecret,
): string {
  const day = now.toISOString().slice(0, 10);
  return createHmac('sha256', secret)
    .update(day)
    .update('\0')
    .update(ip)
    .update('\0')
    .update(userAgent ?? '')
    .digest('hex')
    .slice(0, 16);
}

export function getSearchAttribution(
  request: Pick<FastifyRequest, 'headers' | 'hostname' | 'ip'>,
  now: Date = new Date(),
  secret: Uint8Array = runtimeClientHashSecret,
): SearchAttribution {
  const userAgent = firstHeaderValue(request.headers['user-agent']);
  const originHost = safeHostname(firstHeaderValue(request.headers.origin));
  const referrerHost = safeHostname(firstHeaderValue(request.headers.referer));
  const requestHost = normalizeRequestHost(request.hostname);
  const referringHost = originHost ?? referrerHost;

  let trafficSource: SearchTrafficSource = 'direct_api';
  if (referringHost === requestHost) trafficSource = 'same_site_ui';
  else if (referringHost) trafficSource = 'external_referrer';

  return {
    clientHash: createDailyClientHash(request.ip, userAgent, now, secret),
    clientType: classifySearchClient(userAgent),
    trafficSource,
    ...(originHost ? { originHost } : {}),
    ...(referrerHost ? { referrerHost } : {}),
  };
}
