import { describe, expect, it } from 'bun:test';
import {
  SEARCH_DEPRECATION_URL,
  classifySearchClient,
  createDailyClientHash,
  getSearchAttribution,
  getSearchDeprecationHeaders,
} from '../src/utils/search-observability';

const secret = new Uint8Array(32).fill(7);

describe('search retirement observability', () => {
  it('creates stable hashes within a day and rotates them across days', () => {
    const first = createDailyClientHash('203.0.113.8', 'Mozilla/5.0', new Date('2026-08-18T01:00:00Z'), secret);
    const sameDay = createDailyClientHash('203.0.113.8', 'Mozilla/5.0', new Date('2026-08-18T23:59:00Z'), secret);
    const nextDay = createDailyClientHash('203.0.113.8', 'Mozilla/5.0', new Date('2026-08-19T00:00:00Z'), secret);

    expect(first).toHaveLength(16);
    expect(sameDay).toBe(first);
    expect(nextDay).not.toBe(first);
  });

  it('records only coarse, privacy-safe attribution fields', () => {
    const attribution = getSearchAttribution({
      hostname: 'embed.tweetstack.app',
      ip: '203.0.113.8',
      headers: {
        host: 'embed.tweetstack.app',
        referer: 'https://embed.tweetstack.app/?query=private',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
      },
    } as any, new Date('2026-08-18T12:00:00Z'), secret);

    expect(attribution).toEqual({
      clientHash: expect.any(String),
      clientType: 'browser',
      trafficSource: 'same_site_ui',
      referrerHost: 'embed.tweetstack.app',
    });
    expect(JSON.stringify(attribution)).not.toContain('203.0.113.8');
    expect(JSON.stringify(attribution)).not.toContain('private');
    expect(JSON.stringify(attribution)).not.toContain('Macintosh');
  });

  it('classifies common clients without preserving their user agents', () => {
    expect(classifySearchClient('Mozilla/5.0')).toBe('browser');
    expect(classifySearchClient('curl/8.7.1')).toBe('api_client');
    expect(classifySearchClient('ExampleBot/1.0')).toBe('bot');
    expect(classifySearchClient(undefined)).toBe('unknown');
  });

  it('publishes a valid sunset and deprecation link', () => {
    const headers = getSearchDeprecationHeaders();

    expect(headers.Deprecation).toBe('@1787684400');
    expect(new Date(headers.Sunset!).toISOString()).toBe('2026-08-25T19:00:00.000Z');
    expect(headers.Link).toContain(SEARCH_DEPRECATION_URL);
    expect(headers.Warning).toContain('August 25, 2026');
  });
});
