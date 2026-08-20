"""Compare strong, bounded-memory ID checksums between LanceDB and ClickHouse."""

import json
import os
import re

import lancedb
import numpy as np
import requests


MASK = 2**64 - 1
DATABASE_URI = os.environ.get("LANCEDB_URI", "/data/db")
TABLE_NAME = os.environ.get("LANCEDB_TABLE", "vectors")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:28123")
CLICKHOUSE_USER = os.environ["CLICKHOUSE_USER"]
CLICKHOUSE_PASSWORD = os.environ["CLICKHOUSE_PASSWORD"]
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def identifier(name):
    if not IDENTIFIER.fullmatch(name):
        raise ValueError(f"Invalid ClickHouse identifier: {name}")
    return name


CLICKHOUSE_TABLE = ".".join(
    [
        identifier(os.environ.get("CLICKHOUSE_DATABASE", "vector_bench")),
        identifier(os.environ.get("CLICKHOUSE_VECTOR_TABLE", "vectors")),
    ]
)


def lance_checksum(table):
    count = 0
    total = 0
    xor = 0
    batches = table.search().select(["id"]).to_batches(batch_size=131072)
    for batch in batches:
        ids = batch.column(0).to_numpy(zero_copy_only=False).astype(np.uint64, copy=False)
        count += len(ids)
        total = (total + int(ids.sum(dtype=np.uint64))) & MASK
        xor ^= int(np.bitwise_xor.reduce(ids, initial=np.uint64(0)))
    return {"count": count, "sum_uint64": str(total), "xor_uint64": str(xor)}


def clickhouse_checksum():
    query = """
        SELECT
          count() AS count,
          toString(sumWithOverflow(id)) AS sum_uint64,
          toString(groupBitXor(id)) AS xor_uint64
        FROM {CLICKHOUSE_TABLE}
        FORMAT JSONEachRow
    """.format(CLICKHOUSE_TABLE=CLICKHOUSE_TABLE)
    response = requests.post(
        CLICKHOUSE_URL,
        data=query.encode(),
        auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
        timeout=(10, 300),
    )
    response.raise_for_status()
    result = response.json()
    return {
        "count": int(result["count"]),
        "sum_uint64": result["sum_uint64"],
        "xor_uint64": result["xor_uint64"],
    }


def main():
    table = lancedb.connect(DATABASE_URI).open_table(TABLE_NAME)
    lance = lance_checksum(table)
    clickhouse = clickhouse_checksum()
    print(json.dumps({"match": lance == clickhouse, "lancedb": lance, "clickhouse": clickhouse}))
    if lance != clickhouse:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
