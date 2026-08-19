import { statfs } from 'node:fs/promises';

const qdrantUrl = process.env.QDRANT_URL ?? 'http://172.19.0.2:6333';
const qdrantApiKey = process.env.QDRANT_API_KEY;
const clickhouseUrl = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:28123';
const clickhouseUser = process.env.CLICKHOUSE_USER ?? 'bench';
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD;
const checkpointPath = process.env.CHECKPOINT_PATH ?? '/state/payload-checkpoint.json';
const collection = process.env.QDRANT_COLLECTION ?? 'embeddings';
const scrollSize = Number(process.env.SCROLL_SIZE ?? '1000');
const insertRows = Number(process.env.INSERT_ROWS ?? '10000');
const minimumFreeBytes = BigInt(process.env.MINIMUM_FREE_BYTES ?? String(15 * 1024 ** 3));

if (!qdrantApiKey || !clickhousePassword) {
  throw new Error('QDRANT_API_KEY and CLICKHOUSE_PASSWORD are required');
}

type Checkpoint = {
  offset: string | null;
  insertedRows: number;
  startedAt: string;
};

type QdrantPoint = {
  payload?: { key?: string; metadata?: Record<string, unknown> };
};

async function readCheckpoint(): Promise<Checkpoint> {
  const file = Bun.file(checkpointPath);
  if (await file.exists()) return await file.json() as Checkpoint;
  return { offset: null, insertedRows: 0, startedAt: new Date().toISOString() };
}

async function writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
  const temporaryPath = `${checkpointPath}.tmp`;
  await Bun.write(temporaryPath, `${JSON.stringify(checkpoint)}\n`);
  await Bun.$`mv ${temporaryPath} ${checkpointPath}`.quiet();
}

function rawNextOffset(body: string): string | null {
  return body.match(/"next_page_offset"\s*:\s*(\d+)/)?.[1] ?? null;
}

async function scroll(offset: string | null): Promise<{ points: QdrantPoint[]; nextOffset: string | null }> {
  const offsetFragment = offset === null ? '' : `,"offset":${offset}`;
  const body = `{"limit":${scrollSize},"with_payload":true,"with_vector":false${offsetFragment}}`;
  const response = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'api-key': qdrantApiKey!, 'content-type': 'application/json' },
    body,
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`Qdrant scroll failed: HTTP ${response.status}`);
  const parsed = JSON.parse(responseBody) as { result?: { points?: QdrantPoint[] } };
  return { points: parsed.result?.points ?? [], nextOffset: rawNextOffset(responseBody) };
}

async function insert(points: QdrantPoint[]): Promise<void> {
  const rows = points.map(point => {
    const key = point.payload?.key;
    if (!key || !/^\d+$/.test(key)) throw new Error('point is missing a numeric payload.key');
    return JSON.stringify({
      id: key,
      key,
      metadata: JSON.stringify(point.payload?.metadata ?? {}),
    });
  }).join('\n');
  const query = 'INSERT INTO vector_bench.payloads (id, key, metadata) FORMAT JSONEachRow';
  const response = await fetch(clickhouseUrl, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': clickhouseUser,
      'X-ClickHouse-Key': clickhousePassword!,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: `${query}\n${rows}`,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`ClickHouse insert failed: HTTP ${response.status}: ${detail}`);
  }
}

async function ensureSchema(): Promise<void> {
  const response = await fetch(clickhouseUrl, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': clickhouseUser,
      'X-ClickHouse-Key': clickhousePassword!,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: `
      CREATE TABLE IF NOT EXISTS vector_bench.payloads
      (
        id UInt64,
        key String,
        metadata String CODEC(ZSTD(3)),
        updated_at DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY id
    `,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`ClickHouse schema creation failed: HTTP ${response.status}: ${detail}`);
  }
}

async function availableBytes(): Promise<bigint> {
  const stats = await statfs('/state');
  return BigInt(stats.bavail) * BigInt(stats.bsize);
}

let checkpoint = await readCheckpoint();
let nextOffset = checkpoint.offset;
let pending: QdrantPoint[] = [];
const startedAt = performance.now();
const startingRows = checkpoint.insertedRows;
console.log(JSON.stringify({ event: 'resume', ...checkpoint, scrollSize, insertRows }));
await ensureSchema();

while (true) {
  const page = await scroll(nextOffset);
  pending.push(...page.points);
  nextOffset = page.nextOffset;
  if (pending.length >= insertRows || nextOffset === null) {
    const freeBytes = await availableBytes();
    if (freeBytes < minimumFreeBytes) throw new Error(`disk guard tripped with ${freeBytes} bytes available`);
    if (pending.length) await insert(pending);
    checkpoint = {
      ...checkpoint,
      offset: nextOffset,
      insertedRows: checkpoint.insertedRows + pending.length,
    };
    await writeCheckpoint(checkpoint);
    pending = [];
    const elapsed = Math.max((performance.now() - startedAt) / 1000, 1);
    console.log(JSON.stringify({
      event: 'checkpoint',
      insertedRows: checkpoint.insertedRows,
      rowsPerSecond: Math.round((checkpoint.insertedRows - startingRows) / elapsed),
      freeBytes: freeBytes.toString(),
      nextOffset,
      at: new Date().toISOString(),
    }));
  }
  if (nextOffset === null) break;
}

console.log(JSON.stringify({ event: 'complete', ...checkpoint, at: new Date().toISOString() }));
