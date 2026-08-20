"""Compare ClickHouse- and Lance-backed search APIs using identical vectors."""

import json
import os
import statistics
import time
import urllib.request

import numpy as np


CLICKHOUSE_API = os.environ["CLICKHOUSE_API_URL"].rstrip("/")
LANCEDB_API = os.environ["LANCEDB_API_URL"].rstrip("/")
QUERY_FILE = os.environ.get("QUERY_FILE", "/queries/query-vectors.json")
TOP_K = int(os.environ.get("TOP_K", "10"))


def search(base_url, vector):
    body = json.dumps(
        {
            "vector": vector,
            "k": TOP_K,
            "threshold": 0.1,
            "with_payload": True,
            "with_vector": False,
        }
    ).encode()
    request = urllib.request.Request(
        f"{base_url}/embeddings/search",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "ca-lancedb-benchmark/1"},
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    return payload["results"], (time.perf_counter() - started) * 1000


def rbo(left, right, persistence=0.9):
    overlap = 0.0
    for depth in range(1, TOP_K + 1):
        agreement = len(set(left[:depth]) & set(right[:depth])) / depth
        overlap += (1 - persistence) * agreement * persistence ** (depth - 1)
    overlap += persistence**TOP_K * len(set(left) & set(right)) / TOP_K
    return overlap


def latency(values):
    return {
        "mean_ms": statistics.fmean(values),
        "p50_ms": float(np.percentile(values, 50)),
        "p95_ms": float(np.percentile(values, 95)),
        "max_ms": max(values),
    }


def main():
    payload = json.load(open(QUERY_FILE))
    queries = payload["queries"]
    vectors = payload["vectors"]
    search(CLICKHOUSE_API, vectors[0])
    search(LANCEDB_API, vectors[0])
    clickhouse_latencies = []
    lancedb_latencies = []
    comparisons = []
    for index, (label, vector) in enumerate(zip(queries, vectors)):
        if index % 2:
            lance, lance_ms = search(LANCEDB_API, vector)
            clickhouse, clickhouse_ms = search(CLICKHOUSE_API, vector)
        else:
            clickhouse, clickhouse_ms = search(CLICKHOUSE_API, vector)
            lance, lance_ms = search(LANCEDB_API, vector)
        clickhouse_ids = [str(row["key"]) for row in clickhouse]
        lance_ids = [str(row["key"]) for row in lance]
        clickhouse_latencies.append(clickhouse_ms)
        lancedb_latencies.append(lance_ms)
        comparisons.append(
            {
                "query": label,
                "overlap_at_10": len(set(clickhouse_ids) & set(lance_ids)) / TOP_K,
                "top_1_match": clickhouse_ids[:1] == lance_ids[:1],
                "rbo": rbo(clickhouse_ids, lance_ids),
                "clickhouse_ids": clickhouse_ids,
                "lancedb_ids": lance_ids,
            }
        )
    print(
        json.dumps(
            {
                "queries": len(comparisons),
                "mean_overlap_at_10": statistics.fmean(row["overlap_at_10"] for row in comparisons),
                "mean_rbo": statistics.fmean(row["rbo"] for row in comparisons),
                "top_1_match_rate": statistics.fmean(row["top_1_match"] for row in comparisons),
                "clickhouse": latency(clickhouse_latencies),
                "lancedb": latency(lancedb_latencies),
                "comparisons": comparisons,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
