import type { IVectorStore } from '../interfaces/vector-store.interface.js';
import type {
  DatabaseConfig,
  EmbeddingVector,
  FieldCondition,
  Filter,
  FilterItem,
  SearchFilter,
  SearchQuery,
  SearchResult,
} from '../types/index.js';
import { createContextLogger } from '../observability/logger.js';
import {
  embeddingOperationDuration,
  vectorCount,
  vectorStoreItemsProcessed,
  vectorStoreOperationsTotal,
} from '../observability/metrics.js';

type ClickHouseRow = Record<string, unknown>;

type RetrievedPoint = {
  id: string;
  vector: number[];
  payload: { key: string; metadata?: Record<string, unknown> };
};

export type RetrievedPayload = {
  id: string;
  key: string;
  metadata?: Record<string, unknown>;
};

const NUMERIC_KEY = /^\d+$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ClickHouse ${label}: ${value}`);
  return value;
}

function sqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function parseNumericKey(key: string): string {
  if (!NUMERIC_KEY.test(key)) {
    throw new Error(`ClickHouse vector keys must be unsigned integer strings; received ${key}`);
  }
  return key;
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isFieldCondition(value: FilterItem): value is FieldCondition {
  return typeof value === 'object' && value !== null && 'key' in value;
}

function metadataValue(key: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`Unsupported metadata filter key: ${key}`);
  const path = `$.${key.split('.').map(part => `"${part}"`).join('.')}`;
  return `JSON_VALUE(metadata, ${sqlString(path)})`;
}

function rangeExpression(expression: string, operator: string, rawValue: number | string): string {
  if (typeof rawValue === 'number') return `toFloat64OrNull(${expression}) ${operator} ${rawValue}`;
  const numeric = Number(rawValue);
  if (rawValue.trim() !== '' && Number.isFinite(numeric)) {
    return `toFloat64OrNull(${expression}) ${operator} ${numeric}`;
  }
  return `parseDateTime64BestEffortOrNull(${expression}) ${operator} parseDateTime64BestEffort(${sqlString(rawValue)})`;
}

function fieldExpression(condition: FieldCondition): string {
  const value = metadataValue(condition.key);
  if (condition.match) {
    if (condition.match.text !== undefined) {
      return `positionCaseInsensitiveUTF8(${value}, ${sqlString(condition.match.text)}) > 0`;
    }
    return `${value} = ${sqlString(String(condition.match.value))}`;
  }
  if (!condition.range) throw new Error(`Filter for ${condition.key} has no match or range`);
  const expressions: string[] = [];
  if (condition.range.gt !== undefined) expressions.push(rangeExpression(value, '>', condition.range.gt));
  if (condition.range.gte !== undefined) expressions.push(rangeExpression(value, '>=', condition.range.gte));
  if (condition.range.lt !== undefined) expressions.push(rangeExpression(value, '<', condition.range.lt));
  if (condition.range.lte !== undefined) expressions.push(rangeExpression(value, '<=', condition.range.lte));
  return `(${expressions.join(' AND ')})`;
}

function clauseExpression(filter: Filter): string {
  const groups: string[] = [];
  const render = (item: FilterItem) => isFieldCondition(item) ? fieldExpression(item) : clauseExpression(item);
  if (filter.must?.length) groups.push(`(${filter.must.map(render).join(' AND ')})`);
  if (filter.should?.length) groups.push(`(${filter.should.map(render).join(' OR ')})`);
  if (filter.must_not?.length) groups.push(`NOT (${filter.must_not.map(render).join(' OR ')})`);
  if (!groups.length) throw new Error('ClickHouse filter has no clauses');
  return groups.join(' AND ');
}

function legacyExpression(filter: Record<string, unknown>): string {
  return Object.entries(filter).map(([key, raw]) => {
    const value = metadataValue(key);
    if (typeof raw === 'string') {
      const range = raw.match(/^(>=|<=|>|<)\s*(.+)$/);
      if (range) return rangeExpression(value, range[1]!, range[2]!);
      if (key === 'text' || key === 'original_text') {
        return `positionCaseInsensitiveUTF8(${value}, ${sqlString(raw)}) > 0`;
      }
    }
    return `${value} = ${sqlString(String(raw))}`;
  }).join(' AND ');
}

function filterExpression(filter: SearchFilter): string {
  const keys = Object.keys(filter);
  return keys.some(key => key === 'must' || key === 'should' || key === 'must_not')
    ? clauseExpression(filter as Filter)
    : legacyExpression(filter as Record<string, unknown>);
}

export class ClickHouseVectorStore implements IVectorStore {
  private readonly url: string;
  private readonly user: string;
  private readonly password?: string;
  private readonly timeout: number;
  private readonly dimension: number;
  private readonly candidates: number;
  private readonly database: string;
  private readonly vectorTable: string;
  private readonly payloadTable: string;
  private readonly vectors: string;
  private readonly payloads: string;
  private initialized = false;

  constructor(config: DatabaseConfig) {
    if (!config.clickhouse) throw new Error('ClickHouse configuration is required');
    this.url = new URL(config.clickhouse.url).toString();
    this.user = config.clickhouse.user;
    this.password = config.clickhouse.password;
    this.timeout = config.clickhouse.timeout ?? 30_000;
    this.dimension = config.dimension;
    this.candidates = config.clickhouse.searchCandidates ?? 256;
    this.database = assertIdentifier(config.clickhouse.database, 'database');
    this.vectorTable = assertIdentifier(config.clickhouse.vectorTable, 'vector table');
    this.payloadTable = assertIdentifier(config.clickhouse.payloadTable, 'payload table');
    this.vectors = `${this.database}.${this.vectorTable}`;
    this.payloads = `${this.database}.${this.payloadTable}`;
  }

  private async request(sql: string): Promise<string> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': this.user,
        ...(this.password ? { 'X-ClickHouse-Key': this.password } : {}),
        'content-type': 'text/plain; charset=utf-8',
      },
      body: sql,
      signal: AbortSignal.timeout(this.timeout),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 500)}`);
    return body;
  }

  private async rows(sql: string): Promise<ClickHouseRow[]> {
    const body = await this.request(`${sql.trim()}\nFORMAT JSONEachRow`);
    return body.split('\n').filter(Boolean).map(line => JSON.parse(line) as ClickHouseRow);
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error('ClickHouse vector store is not initialized');
  }

  async initialize(): Promise<void> {
    const columns = await this.rows(`
      SELECT name, type
      FROM system.columns
      WHERE database = ${sqlString(this.database)} AND table = ${sqlString(this.vectorTable)}
    `);
    const embedding = columns.find(row => row.name === 'embedding');
    if (!embedding || !String(embedding.type).includes(`BFloat16`)) {
      throw new Error(`ClickHouse table ${this.vectors} is missing its BFloat16 embedding column`);
    }
    await this.request(`
      CREATE TABLE IF NOT EXISTS ${this.payloads}
      (
        id UInt64,
        key String,
        metadata String CODEC(ZSTD(3)),
        updated_at DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY id
    `);
    this.initialized = true;
  }

  async insert(embeddings: EmbeddingVector[]): Promise<void> {
    this.ensureInitialized();
    if (!embeddings.length) return;
    const ids = embeddings.map(item => parseNumericKey(item.key));
    for (const item of embeddings) {
      if (item.vector.length !== this.dimension) {
        throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${item.vector.length}`);
      }
    }

    const existing = await this.rows(`SELECT toString(id) AS id FROM ${this.vectors} WHERE id IN (${ids.join(',')})`);
    if (existing.length) {
      const duplicateIds = existing.map(row => String(row.id));
      await this.request(`ALTER TABLE ${this.vectors} DELETE WHERE id IN (${duplicateIds.join(',')}) SETTINGS mutations_sync = 1`);
    }

    const vectorRows = embeddings.map(item => JSON.stringify({
      id: item.key,
      batch: 0xffffffff,
      embedding: Array.from(item.vector),
    })).join('\n');
    await this.request(`INSERT INTO ${this.vectors} FORMAT JSONEachRow\n${vectorRows}`);

    const payloadRows = embeddings.map(item => JSON.stringify({
      id: item.key,
      key: item.key,
      metadata: JSON.stringify(item.metadata ?? {}),
    })).join('\n');
    await this.request(`INSERT INTO ${this.payloads} (id, key, metadata) FORMAT JSONEachRow\n${payloadRows}`);
    vectorStoreOperationsTotal.inc({ operation: 'insert', status: 'success' });
    vectorStoreItemsProcessed.inc({ operation: 'insert' }, embeddings.length);
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.ensureInitialized();
    if (query.vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${query.vector.length}`);
    }
    const timer = embeddingOperationDuration.startTimer({ operation: 'search' });
    const logger = createContextLogger({ operation: 'search', store: 'clickhouse', k: query.k, hasFilter: !!query.filter });
    try {
      const vector = Array.from(query.vector, value => Number(value));
      if (vector.some(value => !Number.isFinite(value))) throw new Error('Vector contains invalid values');
      const reference = `CAST([${vector.join(',')}], 'Array(BFloat16)')`;
      const candidateWhere: string[] = [];
      if (query.filter) {
        candidateWhere.push(`id IN (SELECT id FROM ${this.payloads} FINAL WHERE ${filterExpression(query.filter)})`);
      }
      const candidateLimit = Math.max(query.k * 2, query.k);
      const searchCandidates = Math.max(this.candidates, candidateLimit);
      const exactDistance = `cosineDistance(CAST(embedding, 'Array(Float32)'), CAST(reference, 'Array(Float32)'))`;
      const score = `1 - ${exactDistance}`;
      const resultRows = await this.rows(`
        WITH ${reference} AS reference,
        candidates AS
        (
          SELECT id
          FROM ${this.vectors}
          ${candidateWhere.length ? `WHERE ${candidateWhere.join(' AND ')}` : ''}
          ORDER BY cosineDistance(embedding, reference)
          LIMIT ${candidateLimit}
        )
        SELECT toString(id) AS id, ${score} AS score${query.with_vector ? ', embedding AS vector' : ''}
        FROM ${this.vectors}
        WHERE id IN candidates
        ORDER BY ${exactDistance}
        LIMIT ${Math.max(1, Math.floor(query.k))}
        SETTINGS hnsw_candidate_list_size_for_search = ${searchCandidates}
      `);

      const ids = resultRows.map(row => String(row.id));
      const payloadById = new Map<string, { key: string; metadata?: Record<string, unknown> }>();
      if (ids.length && (query.with_payload ?? true)) {
        const payloadRows = await this.rows(`
          SELECT toString(id) AS id, key, metadata
          FROM ${this.payloads} FINAL
          WHERE id IN (${ids.join(',')})
        `);
        for (const row of payloadRows) {
          payloadById.set(String(row.id), {
            key: String(row.key ?? row.id),
            metadata: parseMetadata(row.metadata),
          });
        }
      }

      const results = resultRows.filter(row => query.threshold === undefined || Number(row.score) >= query.threshold).map(row => {
        const id = String(row.id);
        const payload = payloadById.get(id);
        return {
          key: payload?.key ?? id,
          distance: Number(row.score),
          ...((query.with_payload ?? true) && payload?.metadata ? { metadata: payload.metadata } : {}),
          ...(query.with_vector && Array.isArray(row.vector) ? { vector: row.vector.map(Number) } : {}),
        } satisfies SearchResult;
      });
      const elapsed = timer();
      logger.info({ resultCount: results.length, queryTime: elapsed }, 'Vector search completed');
      vectorStoreOperationsTotal.inc({ operation: 'search', status: 'success' });
      vectorStoreItemsProcessed.inc({ operation: 'search' }, results.length);
      return results;
    } catch (error) {
      timer();
      vectorStoreOperationsTotal.inc({ operation: 'search', status: 'error' });
      throw error;
    }
  }

  async delete(keys: string[]): Promise<void> {
    this.ensureInitialized();
    if (!keys.length) return;
    const ids = keys.map(parseNumericKey).join(',');
    await this.request(`ALTER TABLE ${this.vectors} DELETE WHERE id IN (${ids}) SETTINGS mutations_sync = 1`);
    await this.request(`ALTER TABLE ${this.payloads} DELETE WHERE id IN (${ids}) SETTINGS mutations_sync = 1`);
  }

  async exists(key: string): Promise<boolean> {
    this.ensureInitialized();
    const id = parseNumericKey(key);
    const rows = await this.rows(`SELECT 1 AS present FROM ${this.vectors} WHERE id = ${id} LIMIT 1`);
    return rows.length > 0;
  }

  async updateMetadata(updates: Array<{ key: string; metadata: Record<string, unknown> }>): Promise<{ updated: number; failed: number }> {
    this.ensureInitialized();
    const rows = updates.map(item => {
      const id = parseNumericKey(item.key);
      return JSON.stringify({ id, key: item.key, metadata: JSON.stringify(item.metadata) });
    }).join('\n');
    if (rows) await this.request(`INSERT INTO ${this.payloads} (id, key, metadata) FORMAT JSONEachRow\n${rows}`);
    return { updated: updates.length, failed: 0 };
  }

  async retrievePoints(ids: string[]): Promise<RetrievedPoint[]> {
    this.ensureInitialized();
    if (!ids.length) return [];
    const numericIds = ids.map(parseNumericKey);
    const vectors = await this.rows(`
      SELECT toString(id) AS id, embedding AS vector
      FROM ${this.vectors}
      WHERE id IN (${numericIds.join(',')})
    `);
    const payloadRows = await this.rows(`
      SELECT toString(id) AS id, key, metadata
      FROM ${this.payloads} FINAL
      WHERE id IN (${numericIds.join(',')})
    `);
    const payloadById = new Map(payloadRows.map(row => [String(row.id), row]));
    return vectors.map(row => {
      const id = String(row.id);
      const payload = payloadById.get(id);
      return {
        id,
        vector: Array.isArray(row.vector) ? row.vector.map(Number) : [],
        payload: {
          key: String(payload?.key ?? id),
          ...(parseMetadata(payload?.metadata) ? { metadata: parseMetadata(payload?.metadata) } : {}),
        },
      };
    });
  }

  async retrievePayloads(ids: string[]): Promise<RetrievedPayload[]> {
    this.ensureInitialized();
    if (!ids.length) return [];
    const numericIds = ids.map(parseNumericKey);
    const payloadRows = await this.rows(`
      SELECT toString(id) AS id, key, metadata
      FROM ${this.payloads} FINAL
      WHERE id IN (${numericIds.join(',')})
    `);
    return payloadRows.map(row => {
      const id = String(row.id);
      const metadata = parseMetadata(row.metadata);
      return {
        id,
        key: String(row.key ?? id),
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async getStats(): Promise<{ vectorCount: number; dbSize: string }> {
    this.ensureInitialized();
    const rows = await this.rows(`
      SELECT ifNull(total_rows, 0) AS vector_count, ifNull(total_bytes, 0) AS total_bytes
      FROM system.tables
      WHERE database = ${sqlString(this.database)} AND name = ${sqlString(this.vectorTable)}
    `);
    if (!rows.length) throw new Error(`ClickHouse table ${this.vectors} is unavailable`);
    const count = Number(rows[0]!.vector_count);
    const bytes = Number(rows[0]!.total_bytes);
    vectorCount.set(count);
    return { vectorCount: count, dbSize: `${(bytes / 1024 ** 3).toFixed(2)} GB` };
  }

  async close(): Promise<void> {
    this.initialized = false;
  }
}
