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
  await table.createIndex('id', {
    config: Index.btree(),
    waitTimeoutSeconds: 60,
  });
  connection.close();
  return directory;
}

function config(uri: string): DatabaseConfig {
  return {
    type: 'lancedb',
    dimension: 8,
    lancedb: {
      uri,
      table: 'vectors',
      nprobes: 1,
      refineFactor: 2,
      autoOptimize: true,
      scalarIndexRefreshAfterRows: 100_000,
      optimizeAfterRows: 100_000,
      optimizeAfterMutations: 20,
    },
    tweetClickhouse: {
      url: 'http://canonical-clickhouse:8123',
      user: 'search',
      password: 'secret',
      database: 'community_archive',
      hydrationBatchSize: 100,
      filterCandidates: 256,
    },
  };
}

function installClickHouseMock(requests: string[]): void {
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    const sql = String(init?.body ?? '');
    requests.push(sql);
    if (sql.includes('FROM system.databases')) {
      return new Response('{"ok":1}\n');
    }
    if (sql.includes('FROM community_archive.tweet_content_versions')) {
      return new Response('{"id":"1","account_id":"10","created_at":"2026-01-01 00:00:00.000","full_text":"hello","reply_to_tweet_id":"","reply_to_user_id":"","reply_to_username":null,"is_tombstone":0}\n');
    }
    if (sql.includes('FROM community_archive.account_identity_states')) {
      return new Response('{"account_id":"10","username":"alice","account_display_name":"Alice"}\n');
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

describe('LanceDbVectorStore', () => {
  it('serves cosine search from LanceDB and hydrates canonical tweet payloads', async () => {
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
    expect(results[0]?.metadata).toMatchObject({ text: 'hello', username: 'alice' });
    expect(results[0]?.vector).toHaveLength(8);
    expect(requests.some(sql => sql.includes('candidates AS'))).toBe(false);
    await store.close();
  });

  it('filters hydrated candidates and writes mutations only to LanceDB', async () => {
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
    expect(filtered[0]?.key).toBe('1');
    expect(filtered[0]?.metadata).toMatchObject({ provider: 'deepinfra', text: 'hello' });

    const unsignedKey = '18446744073709551001';
    await store.insert([{
      key: unsignedKey,
      vector: new Float32Array([0, 0, 1, 0, 0, 0, 0, 0]),
      metadata: { text: 'new' },
    }]);
    expect(await store.exists(unsignedKey)).toBe(true);
    expect(await store.existingKeys([unsignedKey, '1'])).toContain(unsignedKey);
    expect(requests.some(sql => sql.includes('vector_bench'))).toBe(false);

    await store.delete([unsignedKey]);
    expect(await store.exists(unsignedKey)).toBe(false);
    await store.close();
  });

  it('refreshes only the id B-tree after the scalar threshold', async () => {
    const uri = await createIndexedDatabase();
    installClickHouseMock([]);
    const storeConfig = config(uri);
    storeConfig.lancedb!.autoOptimize = false;
    storeConfig.lancedb!.scalarIndexRefreshAfterRows = 1;
    const store = new LanceDbVectorStore(storeConfig);
    await store.initialize();

    await store.insert([{
      key: '513',
      vector: new Float32Array([0, 0, 1, 0, 0, 0, 0, 0]),
    }]);
    await store.close();

    const connection = await lancedb.connect(uri);
    const table = await connection.openTable('vectors');
    const scalarStats = await table.indexStats('id_idx');
    const vectorStats = await table.indexStats('vector_idx');
    expect(scalarStats?.numUnindexedRows).toBe(0);
    expect(vectorStats?.numUnindexedRows).toBe(1);
    table.close();
    connection.close();
  });
});
