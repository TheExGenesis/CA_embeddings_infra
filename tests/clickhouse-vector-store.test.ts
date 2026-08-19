import { afterEach, describe, expect, it, mock } from 'bun:test';
import { ClickHouseVectorStore } from '../src/stores/clickhouse-vector-store';
import type { DatabaseConfig } from '../src/types';

const config: DatabaseConfig = {
  type: 'clickhouse',
  dimension: 3,
  clickhouse: {
    url: 'http://clickhouse:8123',
    user: 'search',
    password: 'secret',
    database: 'vector_bench',
    vectorTable: 'vectors',
    payloadTable: 'payloads',
    searchCandidates: 256,
  },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ClickHouseVectorStore', () => {
  it('keeps Qdrant score semantics and hydrates payload metadata', async () => {
    const requests: string[] = [];
    const responses = [
      '{"name":"embedding","type":"Array(BFloat16)"}\n',
      '',
      '{"id":"42","score":0.91}\n',
      '{"id":"42","key":"42","metadata":"{\\"text\\":\\"hello\\"}"}\n',
    ];
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body ?? ''));
      return new Response(responses.shift() ?? '', { status: 200 });
    }) as unknown as typeof fetch;

    const store = new ClickHouseVectorStore(config);
    await store.initialize();
    const results = await store.search({
      vector: new Float32Array([1, 0, 0]),
      k: 10,
      threshold: 0.65,
    });

    expect(results).toEqual([{ key: '42', distance: 0.91, metadata: { text: 'hello' } }]);
    expect(requests[2]).toContain("1 - cosineDistance");
    expect(requests[2]).toContain("CAST(embedding, 'Array(Float32)')");
    expect(requests[2]).toContain('LIMIT 20');
    expect(requests[2]).toContain('hnsw_candidate_list_size_for_search = 256');
    expect(requests[2]).not.toContain('>= 0.65');
  });

  it('translates Qdrant-style filters into a ClickHouse payload prefilter', async () => {
    const requests: string[] = [];
    const responses = [
      '{"name":"embedding","type":"Array(BFloat16)"}\n',
      '',
      '',
    ];
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body ?? ''));
      return new Response(responses.shift() ?? '', { status: 200 });
    }) as unknown as typeof fetch;

    const store = new ClickHouseVectorStore(config);
    await store.initialize();
    await store.search({
      vector: new Float32Array([1, 0, 0]),
      k: 5,
      filter: { must: [{ key: 'provider', match: { value: 'deepinfra' } }] },
    });

    expect(requests[2]).toContain('SELECT id FROM vector_bench.payloads FINAL');
    expect(requests[2]).toContain('JSON_VALUE(metadata');
    expect(requests[2]).toContain('deepinfra');
  });
});
