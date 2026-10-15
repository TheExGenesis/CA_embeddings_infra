import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEmbeddingQueue } from '../src/services/sqlite-embedding-queue';
import type { EmbeddingVector } from '../src/types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('SqliteEmbeddingQueue', () => {
  it('uses the configured vector-store insert chunk size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ca-embedding-queue-'));
    temporaryDirectories.push(directory);
    const insertedBatchSizes: number[] = [];
    const embeddingService = {
      insert: async (embeddings: EmbeddingVector[]) => {
        insertedBatchSizes.push(embeddings.length);
      },
    };
    const queue = new SqliteEmbeddingQueue(
      join(directory, 'queue.db'),
      embeddingService,
      10,
      2,
      1,
    );
    await queue.initialize();
    await queue.enqueue([1, 2, 3].map(key => ({
      key: String(key),
      vector: new Float32Array([key, key + 1]),
    })));

    for (let attempt = 0; attempt < 100 && insertedBatchSizes.length < 2; attempt += 1) {
      await Bun.sleep(10);
    }

    await queue.shutdown();
    queue.close();
    expect(insertedBatchSizes).toEqual([2, 1]);
  });
});
