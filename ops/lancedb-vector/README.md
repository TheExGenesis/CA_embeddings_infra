# LanceDB vector backend

LanceDB can serve unfiltered cosine vector searches without changing the
public `POST /embeddings/search` contract. ClickHouse remains online and owns
payload hydration, metadata-filtered searches, and rollback-safe writes.

## Production contract

- Lance table: `vectors`
- Columns: `id UInt64`, `vector FixedSizeList<Float16>[1024]`
- Index: cosine `IVF_RQ`, one bit per dimension, 4,096 partitions
- Scalar index: `BTree` on `id` for point reads, upserts, and deletes
- Search: 64 IVF probes and refinement factor 2
- Payloads and metadata updates: ClickHouse `vector_bench.payloads`
- Filtered vector searches: ClickHouse fallback
- Inserts and deletes: ClickHouse first, then LanceDB
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
LANCEDB_WRITE_THROUGH_CLICKHOUSE=true
LANCEDB_OPTIMIZE_AFTER_ROWS=100000
LANCEDB_OPTIMIZE_AFTER_MUTATIONS=1000
```

The ClickHouse variables documented in `../clickhouse-vector/README.md` remain
required. Mount the volume that contains the `db` directory at `/data/lancedb`
and make it writable by the application user, UID/GID 1001.

Before cutover, run `catchup.py` in the LanceDB maintenance image with the
runtime ClickHouse credentials and the database volume mounted at `/data`.
It creates the `id` B-tree if needed and inserts IDs missing from the API-write
batch (`4294967295`); follow it with `table.optimize()` so both indexes report
zero unindexed rows. Run `checksum_parity.py` after catch-up; it compares row
count plus UInt64 sum and XOR without loading all IDs into memory.

## Cutover gates

Do not cut over unless all of these pass against the full corpus:

1. Lance row count equals the captured ClickHouse snapshot, followed by a
   catch-up of newer ClickHouse API-write rows.
2. The active Lance index reports the expected type, distance, indexed rows,
   and an understood unindexed tail.
3. Representative text searches preserve the existing response shape and have
   strong top-10 agreement with ClickHouse without a qualitative regression.
4. Lance p95 search latency is no worse than ClickHouse under the same query
   set and concurrency.
5. Insert, update, delete, retrieve, threshold, payload suppression, vector
   inclusion, and filtered-search fallback smoke checks pass.
6. The prior ClickHouse-backed application container and configuration are
   recorded and available for rollback.

## Monitoring

The API exports:

- `lancedb_indexed_rows`
- `lancedb_unindexed_rows`
- `lancedb_clickhouse_vector_count_gap`
- `lancedb_optimize_total{status}`
- `lancedb_filter_fallback_total`
- `lancedb_write_through_total{operation,status}`
- the existing search latency, operation, error, process RSS and vector-count
  metrics

Alert on a persistent nonzero count gap, growing unindexed rows, optimize
errors, API health failures, disk exhaustion, or a material p95 latency
regression. The host-level Grafana agent must continue monitoring the API,
ClickHouse, memory and disk because both backends remain live during rollout.

## Rollback

1. Stop routing traffic to the Lance-backed application.
2. Restore the recorded ClickHouse-backed application configuration or set
   `VECTOR_STORE=clickhouse`.
3. Start the ClickHouse-backed application and verify `/health`.
4. Run one authenticated text search plus one retrieve request.
5. Confirm ClickHouse vector/payload parity and normal API error rate.

Rollback does not authorize deleting the LanceDB volume. LanceDB deletion is a
separate destructive operation after the rollback window and data authority
have been reviewed.
