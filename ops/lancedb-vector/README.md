# LanceDB vector backend

LanceDB serves cosine vector searches without changing the public
`POST /embeddings/search` contract. The canonical tweet ClickHouse database is
used only for read-only result hydration and policy filtering; it contains no
vector index and receives no vector writes.

## Production contract

- Lance table: `vectors`
- Columns: `id UInt64`, `vector FixedSizeList<Float16>[1024]`
- Index: cosine `IVF_RQ`, one bit per dimension, 4,096 partitions
- Scalar index: `BTree` on `id` for point reads, upserts, and deletes
- Search: 64 IVF probes and refinement factor 2
- Automatic optimization: disabled during historical bulk loading; run one
  controlled `optimize()` after the backfill
- Payloads and policy: hydrated from canonical tweet projections in ClickHouse
- Filtered vector searches: bounded Lance candidate search, then canonical
  metadata filtering
- Inserts and deletes: LanceDB only
- Index maintenance: background `optimize()` after 100,000 modified rows or
  1,000 mutation operations
- Concurrency: exactly one writable API container may mount the local database

Set:

```text
VECTOR_STORE=lancedb
LANCEDB_URI=/data/lancedb/db
LANCEDB_TABLE=vectors
LANCEDB_NPROBES=64
LANCEDB_REFINE_FACTOR=2
LANCEDB_AUTO_OPTIMIZE=false
TWEET_CLICKHOUSE_URL=http://127.0.0.1:18123
TWEET_CLICKHOUSE_DATABASE=community_archive
LANCEDB_OPTIMIZE_AFTER_ROWS=100000
LANCEDB_OPTIMIZE_AFTER_MUTATIONS=1000
```

Use a read-only ClickHouse account for the `TWEET_CLICKHOUSE_*` settings. Mount
the volume that contains the `db` directory at `/data/lancedb` and make it
writable by the application user, UID/GID 1001.

New and historical canonical tweets are reconciled through the authenticated
API writer. The worker checks `/embeddings/exists`, requests paid embeddings
only for missing IDs, confirms each write, and persists its cursor before
advancing.

## Cutover gates

Do not cut over unless all of these pass against the full corpus:

1. The historical backfill cursor advances and the recent reconciler reports a
   fresh canonical ClickHouse watermark.
2. The active Lance index reports the expected type, distance, indexed rows,
   and an understood unindexed tail.
3. Representative text searches preserve the existing response shape and have
   strong top-10 agreement with ClickHouse without a qualitative regression.
4. Lance p95 search latency is no worse than ClickHouse under the same query
   set and concurrency.
5. Insert, delete, retrieve, threshold, payload suppression, vector inclusion,
   canonical hydration, and filtered-search smoke checks pass.

## Monitoring

The API exports:

- `lancedb_indexed_rows`
- `lancedb_unindexed_rows`
- `lancedb_optimize_total{status}`
- `lancedb_filtered_search_total`
- `lancedb_mutation_total{operation,status}`
- the existing search latency, operation, error, process RSS and vector-count
  metrics

Alert on ingestion staleness, growing unindexed rows, optimize errors, API
health failures, disk exhaustion, embedding spend, or a material p95 latency
regression. Host-level monitoring covers the API, LanceDB, memory, and disk;
source-host monitoring covers reconciliation freshness and spend.

## Rollback

Restore the previous application image while preserving the LanceDB volume,
then verify `/health`, one text search, and one retrieve request. The retired
vector ClickHouse volume is not a rollback target; it is rebuildable from the
canonical tweet corpus if a separate migration is ever required.
