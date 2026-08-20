import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as lancedb from '@lancedb/lancedb';
import { Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float16, Schema, Uint64 } from 'apache-arrow';
import { LanceDbVectorStore } from '../src/stores/lancedb-vector-store';
import type { DatabaseConfig } from '../src/types';

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createIndexedDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ca-lancedb-store-'));
  temporaryDirectories.push(directory);
  const connection = await lancedb.connect(directory);
  const rows = Array.from({ length: 512 }, (_, index) => ({
    id: BigInt(index + 1),
    vector: Array.from({ length: 8 }, (__, dimension) => {
      if (index === 0) return dimension === 0 ? 1 : 0;
      if (index === 1) return dimension === 1 ? 1 : 0;
      return ((index * 17 + dimension * 13) % 101) / 100;
    }),
  }));
  const schema = new Schema([
    new Field('id', new Uint64(), false),
    new Field('vector', new FixedSizeList(8, new Field('item', new Float16())), false),
  ]);
  const table = await connection.createTable('vectors', makeArrowTable(rows, { schema }));
  await table.createIndex('vector', {
    config: Index.ivfRq({ distanceType: 'cosine', numPartitions: 1, numBits: 1 }),
    waitTimeoutSeconds: 60,
  });
  connection.close();
  return directory;
}

function config(uri: string): DatabaseConfig {
  return {
    type: 'lancedb',
    dimension: 8,
    clickhouse: {
      url: 'http://clickhouse:8123',
      user: 'search',
      password: 'secret',
      database: 'vector_bench',
      vectorTable: 'vectors',
      payloadTable: 'payloads',
      searchCandidates: 256,
    },
    lancedb: {
      uri,
      table: 'vectors',
      nprobes: 1,
      refineFactor: 2,
      writeThroughClickHouse: true,
      optimizeAfterRows: 100_000,
      optimizeAfterMutations: 20,
    },
  };
}

function installClickHouseMock(requests: string[]): void {
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    const sql = String(init?.body ?? '');
    requests.push(sql);
    if (sql.includes('FROM system.columns')) {
      return new Response('{"name":"embedding","type":"Array(BFloat16)"}\n');
    }
    if (sql.includes('candidates AS')) {
      return new Response('{"id":"1","score":0.9}\n');
    }
    if (sql.includes('FROM vector_bench.payloads FINAL')) {
      return new Response('{"id":"1","key":"1","metadata":"{\\"text\\":\\"hello\\"}"}\n');
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

describe('LanceDbVectorStore', () => {
  it('serves unfiltered cosine search from LanceDB and hydrates ClickHouse payloads', async () => {
    const uri = await createIndexedDatabase();
    const requests: string[] = [];
    installClickHouseMock(requests);
    const store = new LanceDbVectorStore(config(uri));
    await store.initialize();

    const results = await store.search({
      vector: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      k: 1,
      with_vector: true,
    });

    expect(results[0]?.key).toBe('1');
    expect(results[0]?.distance).toBeGreaterThan(0.99);
    expect(results[0]?.metadata).toEqual({ text: 'hello' });
    expect(results[0]?.vector).toHaveLength(8);
    expect(requests.some(sql => sql.includes('candidates AS'))).toBe(false);
    await store.close();
  });

  it('falls back to ClickHouse for filters and writes mutations to both stores', async () => {
    const uri = await createIndexedDatabase();
    const requests: string[] = [];
    installClickHouseMock(requests);
    const store = new LanceDbVectorStore(config(uri));
    await store.initialize();

    const filtered = await store.search({
      vector: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      k: 1,
      filter: { provider: 'deepinfra' },
    });
    expect(filtered[0]).toEqual({ key: '1', distance: 0.9, metadata: { text: 'hello' } });
    expect(requests.some(sql => sql.includes('candidates AS'))).toBe(true);

    const unsignedKey = '18446744073709551001';
    await store.insert([{
      key: unsignedKey,
      vector: new Float32Array([0, 0, 1, 0, 0, 0, 0, 0]),
      metadata: { text: 'new' },
    }]);
    expect(await store.exists(unsignedKey)).toBe(true);
    expect(requests.some(sql => sql.includes('INSERT INTO vector_bench.vectors'))).toBe(true);

    await store.delete([unsignedKey]);
    expect(await store.exists(unsignedKey)).toBe(false);
    expect(requests.some(sql => sql.includes('ALTER TABLE vector_bench.vectors DELETE'))).toBe(true);
    await store.close();
  });
});
