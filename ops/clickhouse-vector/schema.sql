CREATE DATABASE IF NOT EXISTS vector_bench;

CREATE TABLE IF NOT EXISTS vector_bench.vectors
(
    id UInt64,
    batch UInt32,
    embedding Array(BFloat16),
    INDEX embedding_hnsw embedding
        TYPE vector_similarity('hnsw', 'cosineDistance', 1024, 'b1', 16, 100)
        GRANULARITY 100000000
)
ENGINE = MergeTree
PARTITION BY batch
ORDER BY id
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS vector_bench.payloads
(
    id UInt64,
    key String,
    metadata String CODEC(ZSTD(3)),
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;
