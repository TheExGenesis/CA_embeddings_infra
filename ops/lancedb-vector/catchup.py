"""Upsert ClickHouse API-write vectors into an existing LanceDB table."""

import json
import os
import re
from pathlib import Path

import lancedb
import numpy as np
import pyarrow as pa
import requests
from lancedb.index import BTree


DIMENSION = int(os.environ.get("VECTOR_DIMENSION", "1024"))
BATCH = int(os.environ.get("CLICKHOUSE_BATCH", str(0xFFFFFFFF)))
DATABASE_URI = Path(os.environ.get("LANCEDB_URI", "/data/db"))
TABLE_NAME = os.environ.get("LANCEDB_TABLE", "vectors")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:28123")
CLICKHOUSE_USER = os.environ["CLICKHOUSE_USER"]
CLICKHOUSE_PASSWORD = os.environ["CLICKHOUSE_PASSWORD"]
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def identifier(name: str) -> str:
    if not IDENTIFIER.fullmatch(name):
        raise ValueError(f"Invalid ClickHouse identifier: {name}")
    return name


CLICKHOUSE_TABLE = ".".join(
    [
        identifier(os.environ.get("CLICKHOUSE_DATABASE", "vector_bench")),
        identifier(os.environ.get("CLICKHOUSE_VECTOR_TABLE", "vectors")),
    ]
)


def clickhouse_request(query: str, *, stream: bool = False) -> requests.Response:
    response = requests.post(
        CLICKHOUSE_URL,
        params={"max_threads": "2", "max_memory_usage": str(2 * 1024**3)},
        data=query.encode(),
        auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
        headers={"Accept-Encoding": "identity"},
        stream=stream,
        timeout=(10, 3600),
    )
    response.raise_for_status()
    return response


def source_count() -> int:
    response = clickhouse_request(
        f"SELECT count() FROM {CLICKHOUSE_TABLE} WHERE batch = {BATCH} FORMAT TSV"
    )
    return int(response.text.strip())


def clickhouse_batches(rows: int):
    response = clickhouse_request(
        f"""
        SELECT id, arrayMap(x -> toFloat32(x), embedding) AS embedding
        FROM {CLICKHOUSE_TABLE}
        WHERE batch = {BATCH}
        FORMAT RowBinary
        """,
        stream=True,
    )
    row_dtype = np.dtype(
        [("id", "<u8"), ("length_marker", ("u1", 2)), ("embedding", ("<f4", DIMENSION))]
    )
    emitted = 0
    while emitted < rows:
        batch_rows = min(4096, rows - emitted)
        remaining = batch_rows * row_dtype.itemsize
        chunks = []
        while remaining:
            chunk = response.raw.read(remaining)
            if not chunk:
                raise RuntimeError(f"ClickHouse response ended after {emitted} rows")
            chunks.append(chunk)
            remaining -= len(chunk)
        source = np.frombuffer(b"".join(chunks), dtype=row_dtype)
        if not np.all(source["length_marker"] == np.asarray([0x80, 0x08], dtype=np.uint8)):
            raise RuntimeError("ClickHouse returned a vector with the wrong dimension")
        ids = pa.array(source["id"], type=pa.uint64())
        values = pa.array(source["embedding"].astype(np.float16).reshape(-1), type=pa.float16())
        vectors = pa.FixedSizeListArray.from_arrays(values, DIMENSION)
        emitted += batch_rows
        yield pa.RecordBatch.from_arrays([ids, vectors], ["id", "vector"])


def main():
    table = lancedb.connect(str(DATABASE_URI)).open_table(TABLE_NAME)
    if not any("id" in index.columns for index in table.list_indices()):
        table.create_index("id", config=BTree(), replace=True)

    rows = source_count()
    schema = pa.schema(
        [
            pa.field("id", pa.uint64(), nullable=False),
            pa.field("vector", pa.list_(pa.float16(), DIMENSION), nullable=False),
        ]
    )
    reader = pa.RecordBatchReader.from_batches(schema, clickhouse_batches(rows))
    result = (
        table.merge_insert("id")
        .when_not_matched_insert_all()
        .execute(reader)
    )
    print(
        json.dumps(
            {
                "source_rows": rows,
                "table_rows": table.count_rows(),
                "merge": str(result),
                "indices": [
                    {
                        "name": index.name,
                        "type": index.index_type,
                        "columns": list(index.columns),
                        "indexed_rows": index.num_indexed_rows,
                        "unindexed_rows": index.num_unindexed_rows,
                    }
                    for index in table.list_indices()
                ],
            }
        )
    )


if __name__ == "__main__":
    main()
