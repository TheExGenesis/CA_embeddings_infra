"""Measure LanceDB ANN latency and recall for a fixed query-vector file."""

import json
import os
import statistics
import time
from pathlib import Path

import lancedb
import numpy as np


DATABASE_URI = os.environ.get("LANCEDB_URI", "/data/db")
TABLE_NAME = os.environ.get("LANCEDB_TABLE", "vectors")
QUERY_FILE = Path(os.environ.get("QUERY_FILE", "/queries/query-vectors.json"))
TOP_K = int(os.environ.get("TOP_K", "10"))
QUERY_LIMIT = int(os.environ.get("QUERY_LIMIT", "20"))
CONFIGS = [
    tuple(map(int, value.split(":")))
    for value in os.environ.get("LANCEDB_BENCH_CONFIGS", "64:2,128:2,256:2").split(",")
]


def percentile(values, value):
    return float(np.percentile(np.asarray(values, dtype=np.float64), value))


def run(table, vectors, *, exact=False, nprobes=64, refine_factor=2):
    results = []
    latencies = []
    for vector in vectors:
        query = table.search(vector).metric("cosine").select(["id", "_distance"])
        if exact:
            query = query.bypass_vector_index()
        else:
            query = query.nprobes(nprobes).refine_factor(refine_factor)
        started = time.perf_counter()
        results.append([int(row["id"]) for row in query.limit(TOP_K).to_list()])
        latencies.append((time.perf_counter() - started) * 1000)
    return results, latencies


def latency(values):
    return {
        "mean_ms": statistics.fmean(values),
        "p50_ms": percentile(values, 50),
        "p95_ms": percentile(values, 95),
        "max_ms": max(values),
    }


def main():
    payload = json.loads(QUERY_FILE.read_text())
    vectors = payload["vectors"][:QUERY_LIMIT]
    table = lancedb.connect(DATABASE_URI).open_table(TABLE_NAME)
    table.search(vectors[0]).metric("cosine").nprobes(CONFIGS[0][0]).limit(TOP_K).to_list()
    expected, exact_latencies = run(table, vectors, exact=True)
    results = {"exact": latency(exact_latencies), "configs": []}
    for nprobes, refine_factor in CONFIGS:
        actual, latencies = run(
            table,
            vectors,
            nprobes=nprobes,
            refine_factor=refine_factor,
        )
        recall = statistics.fmean(
            len(set(want) & set(got)) / TOP_K for want, got in zip(expected, actual)
        )
        results["configs"].append(
            {
                "nprobes": nprobes,
                "refine_factor": refine_factor,
                "recall_at_10": recall,
                **latency(latencies),
            }
        )
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
