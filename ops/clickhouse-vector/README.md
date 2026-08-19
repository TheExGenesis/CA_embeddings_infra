# ClickHouse vector backend

The production semantic-search API can use ClickHouse without changing its
public `POST /embeddings/search` contract. The vector index intentionally
matches the former Qdrant collection: cosine distance, HNSW M=16,
construction EF=100, and binary quantization. Searches retain 256 candidates,
matching Qdrant's search EF=128 plus 2x oversampling before rescoring.

Apply `schema.sql`, import both vector and payload count parity, and set:

```text
VECTOR_STORE=clickhouse
CLICKHOUSE_URL=http://ca-vector-ch-full-bench:8123
CLICKHOUSE_USER=<runtime user>
CLICKHOUSE_PASSWORD=<runtime secret>
CLICKHOUSE_DATABASE=vector_bench
CLICKHOUSE_VECTOR_TABLE=vectors
CLICKHOUSE_PAYLOAD_TABLE=payloads
CLICKHOUSE_SEARCH_CANDIDATES=256
```

Keep ClickHouse loopback-only or on the private Docker network. Never expose
ports 8123 or 9000 publicly. The API health endpoint checks table availability,
and the ClickHouse container must use an `unless-stopped` restart policy.

Before cutover, verify vector and payload count parity, replay representative
searches, and capture the current application container name. Keep the stopped
Qdrant container and its volume as the rollback boundary.

Rollback is: stop the ClickHouse-backed application, restart Qdrant, restore
the prior application configuration/container, then verify `/health` and one
authenticated text search. Stopping Qdrant never authorizes deleting its
container, volume, or snapshots.
