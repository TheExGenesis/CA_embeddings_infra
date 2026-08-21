import * as lancedb from '@lancedb/lancedb';
import type { Connection, Table } from '@lancedb/lancedb';
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
  collectionIndexedPercentage,
  embeddingOperationDuration,
  lanceDbFilteredSearchTotal,
  lanceDbIndexedRows,
  lanceDbOptimizeTotal,
  lanceDbUnindexedRows,
  lanceDbMutationTotal,
  vectorCount,
  vectorStoreItemsProcessed,
  vectorStoreOperationsTotal,
} from '../observability/metrics.js';
import { TweetClickHouseStore } from './tweet-clickhouse-store.js';

type RetrievedPoint = {
  id: string;
  vector: number[];
  payload: { key: string; metadata?: Record<string, unknown> };
};

const NUMERIC_KEY = /^\d+$/;

function parseNumericKey(key: string): string {
  if (!NUMERIC_KEY.test(key)) {
    throw new Error(`LanceDB vector keys must be unsigned integer strings; received ${key}`);
  }
  return key;
}

function sqlUInt64(key: string): string {
  return `CAST('${parseNumericKey(key)}' AS BIGINT UNSIGNED)`;
}

function sqlIds(ids: string[]): string {
  return ids.map(sqlUInt64).join(',');
}

function vectorValues(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (value && typeof value === 'object' && Symbol.iterator in value) {
    return Array.from(value as Iterable<unknown>, Number);
  }
  return [];
}

function isFieldCondition(value: FilterItem): value is FieldCondition {
  return typeof value === 'object' && value !== null && 'key' in value;
}

function metadataValue(metadata: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[part];
  }, metadata);
}

function comparable(value: unknown): number | string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const numeric = Number(value);
  if (String(value).trim() !== '' && Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(String(value));
  return Number.isNaN(timestamp) ? String(value) : timestamp;
}

function matchesField(metadata: Record<string, unknown>, condition: FieldCondition): boolean {
  const value = metadataValue(metadata, condition.key);
  if (condition.match) {
    if (condition.match.text !== undefined) {
      return String(value ?? '').toLocaleLowerCase().includes(condition.match.text.toLocaleLowerCase());
    }
    return String(value) === String(condition.match.value);
  }
  if (!condition.range) return false;
  const left = comparable(value);
  if (left === undefined) return false;
  const checks: boolean[] = [];
  for (const [operator, raw] of Object.entries(condition.range)) {
    const right = comparable(raw);
    if (right === undefined || typeof left !== typeof right) return false;
    if (operator === 'gt') checks.push(left > right);
    if (operator === 'gte') checks.push(left >= right);
    if (operator === 'lt') checks.push(left < right);
    if (operator === 'lte') checks.push(left <= right);
  }
  return checks.length > 0 && checks.every(Boolean);
}

function matchesClause(metadata: Record<string, unknown>, filter: Filter): boolean {
  const matches = (item: FilterItem) => isFieldCondition(item)
    ? matchesField(metadata, item)
    : matchesClause(metadata, item);
  if (filter.must?.some(item => !matches(item))) return false;
  if (filter.should?.length && !filter.should.some(matches)) return false;
  if (filter.must_not?.some(matches)) return false;
  return true;
}

function matchesFilter(metadata: Record<string, unknown>, filter: SearchFilter): boolean {
  const keys = Object.keys(filter);
  if (keys.some(key => key === 'must' || key === 'should' || key === 'must_not')) {
    return matchesClause(metadata, filter as Filter);
  }
  return Object.entries(filter).every(([key, raw]) => {
    const value = metadataValue(metadata, key);
    if (typeof raw === 'string') {
      const range = raw.match(/^(>=|<=|>|<)\s*(.+)$/);
      if (range) {
        const condition: FieldCondition = { key, range: { [range[1] === '>' ? 'gt' : range[1] === '>=' ? 'gte' : range[1] === '<' ? 'lt' : 'lte']: range[2] } };
        return matchesField(metadata, condition);
      }
      if (key === 'text' || key === 'original_text') return String(value ?? '').toLocaleLowerCase().includes(raw.toLocaleLowerCase());
    }
    return String(value) === String(raw);
  });
}

export class LanceDbVectorStore implements IVectorStore {
  private readonly uri: string;
  private readonly tableName: string;
  private readonly dimension: number;
  private readonly nprobes: number;
  private readonly refineFactor: number;
  private readonly autoOptimize: boolean;
  private readonly filterCandidates: number;
  private readonly optimizeAfterRows: number;
  private readonly optimizeAfterMutations: number;
  private readonly tweets: TweetClickHouseStore;
  private connection?: Connection;
  private table?: Table;
  private modifiedRows = 0;
  private mutationOperations = 0;
  private optimizePromise?: Promise<void>;

  constructor(config: DatabaseConfig) {
    if (!config.lancedb) throw new Error('LanceDB configuration is required');
    if (!config.tweetClickhouse) throw new Error('Canonical tweet ClickHouse configuration is required for LanceDB payloads');
    this.uri = config.lancedb.uri;
    this.tableName = config.lancedb.table;
    this.dimension = config.dimension;
    this.nprobes = Math.max(1, Math.floor(config.lancedb.nprobes));
    this.refineFactor = Math.max(1, Math.floor(config.lancedb.refineFactor));
    this.autoOptimize = config.lancedb.autoOptimize;
    this.filterCandidates = Math.max(1, Math.floor(config.tweetClickhouse.filterCandidates));
    this.optimizeAfterRows = Math.max(1, Math.floor(config.lancedb.optimizeAfterRows));
    this.optimizeAfterMutations = Math.max(1, Math.floor(config.lancedb.optimizeAfterMutations));
    this.tweets = new TweetClickHouseStore(config);
  }

  private currentTable(): Table {
    if (!this.table) throw new Error('LanceDB vector store is not initialized');
    return this.table;
  }

  async initialize(): Promise<void> {
    await this.tweets.initialize();
    this.connection = await lancedb.connect(this.uri);
    this.table = await this.connection.openTable(this.tableName);
    const schema = await this.table.schema();
    const vectorField = schema.fields.find(field => field.name === 'vector');
    const listSize = (vectorField?.type as { listSize?: number } | undefined)?.listSize;
    if (!vectorField || listSize !== this.dimension) {
      throw new Error(`LanceDB table ${this.tableName} must contain a ${this.dimension}-dimension vector column`);
    }
    const indices = await this.table.listIndices();
    const vectorIndex = indices.find(index => index.columns.includes('vector'));
    if (!vectorIndex) throw new Error(`LanceDB table ${this.tableName} has no vector index`);
    await this.updateIndexMetrics();
  }

  private async updateIndexMetrics(): Promise<void> {
    const table = this.currentTable();
    const index = (await table.listIndices()).find(item => item.columns.includes('vector'));
    if (!index) return;
    const stats = await table.indexStats(index.name);
    if (!stats) return;
    lanceDbIndexedRows.set(stats.numIndexedRows);
    lanceDbUnindexedRows.set(stats.numUnindexedRows);
    const total = stats.numIndexedRows + stats.numUnindexedRows;
    collectionIndexedPercentage.set(
      { collection: this.tableName },
      total === 0 ? 100 : (stats.numIndexedRows / total) * 100,
    );
  }

  private recordMutation(rows: number): void {
    if (!this.autoOptimize) return;
    this.modifiedRows += rows;
    this.mutationOperations += 1;
    if (
      !this.optimizePromise &&
      (this.modifiedRows >= this.optimizeAfterRows || this.mutationOperations >= this.optimizeAfterMutations)
    ) {
      this.optimizePromise = this.optimizeInBackground();
    }
  }

  private async optimizeInBackground(): Promise<void> {
    const logger = createContextLogger({ operation: 'optimize', store: 'lancedb' });
    const rowsAtStart = this.modifiedRows;
    const operationsAtStart = this.mutationOperations;
    try {
      await this.currentTable().optimize();
      this.modifiedRows = Math.max(0, this.modifiedRows - rowsAtStart);
      this.mutationOperations = Math.max(0, this.mutationOperations - operationsAtStart);
      await this.updateIndexMetrics();
      lanceDbOptimizeTotal.inc({ status: 'success' });
      logger.info('LanceDB optimize completed');
    } catch (error) {
      lanceDbOptimizeTotal.inc({ status: 'error' });
      logger.error({ error }, 'LanceDB optimize failed');
    } finally {
      this.optimizePromise = undefined;
    }
  }

  async insert(embeddings: EmbeddingVector[]): Promise<void> {
    if (!embeddings.length) return;
    for (const item of embeddings) {
      parseNumericKey(item.key);
      if (item.vector.length !== this.dimension) {
        throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${item.vector.length}`);
      }
    }
    const rows = embeddings.map(item => ({
      id: BigInt(item.key),
      vector: Array.from(item.vector, Number),
    }));
    try {
      await this.currentTable()
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows);
      lanceDbMutationTotal.inc({ operation: 'insert', status: 'success' });
    } catch (error) {
      lanceDbMutationTotal.inc({ operation: 'insert', status: 'error' });
      throw error;
    }
    this.recordMutation(rows.length);
    vectorStoreOperationsTotal.inc({ operation: 'insert', status: 'success' });
    vectorStoreItemsProcessed.inc({ operation: 'insert' }, rows.length);
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (query.vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch. Expected ${this.dimension}, got ${query.vector.length}`);
    }
    const timer = embeddingOperationDuration.startTimer({ operation: 'search' });
    const logger = createContextLogger({ operation: 'search', store: 'lancedb', k: query.k });
    try {
      const columns = ['id', '_distance', ...(query.with_vector ? ['vector'] : [])];
      const requested = Math.max(1, Math.floor(query.k));
      const candidateLimit = query.filter
        ? Math.max(requested, this.filterCandidates)
        : Math.max(requested * 2, requested + 10);
      const rows = await this.currentTable()
        .vectorSearch(query.vector)
        .distanceType('cosine')
        .nprobes(this.nprobes)
        .refineFactor(this.refineFactor)
        .select(columns)
        .limit(candidateLimit)
        .toArray();
      const ids = rows.map(row => String(row.id));
      // Canonical hydration is also the policy gate: absent, opted-out, and
      // tombstoned tweets never escape even when payload output is disabled.
      const payloads = await this.tweets.retrievePayloads(ids);
      const payloadById = new Map(payloads.map(payload => [payload.id, payload]));
      const results = rows
        .map(row => {
          const id = String(row.id);
          const score = 1 - Number(row._distance);
          const payload = payloadById.get(id);
          if (!payload?.metadata) return undefined;
          if (query.filter && !matchesFilter(payload.metadata, query.filter)) return undefined;
          return {
            key: payload?.key ?? id,
            distance: score,
            ...((query.with_payload ?? true) && payload?.metadata ? { metadata: payload.metadata } : {}),
            ...(query.with_vector ? { vector: vectorValues(row.vector) } : {}),
          } satisfies SearchResult;
        })
        .filter((result): result is SearchResult => result !== undefined)
        .filter(result => query.threshold === undefined || result.distance >= query.threshold)
        .slice(0, requested);
      if (query.filter) lanceDbFilteredSearchTotal.inc();
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
    if (!keys.length) return;
    const ids = sqlIds(keys);
    try {
      await this.currentTable().delete(`id IN (${ids})`);
      lanceDbMutationTotal.inc({ operation: 'delete', status: 'success' });
    } catch (error) {
      lanceDbMutationTotal.inc({ operation: 'delete', status: 'error' });
      throw error;
    }
    this.recordMutation(keys.length);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.currentTable().countRows(`id = ${sqlUInt64(key)}`)) > 0;
  }

  async existingKeys(keys: string[]): Promise<string[]> {
    if (!keys.length) return [];
    const ids = keys.map(parseNumericKey);
    const rows = await this.currentTable()
      .query()
      .where(`id IN (${sqlIds(ids)})`)
      .select(['id'])
      .toArray();
    return rows.map(row => String(row.id));
  }

  async retrievePoints(ids: string[]): Promise<RetrievedPoint[]> {
    if (!ids.length) return [];
    const numericIds = ids.map(parseNumericKey);
    const rows = await this.currentTable()
      .query()
      .where(`id IN (${sqlIds(numericIds)})`)
      .select(['id', 'vector'])
      .toArray();
    const payloads = await this.tweets.retrievePayloads(numericIds);
    const payloadById = new Map(payloads.map(payload => [payload.id, payload]));
    const rowById = new Map(rows.map(row => [String(row.id), row]));
    return numericIds.flatMap(id => {
      const row = rowById.get(id);
      if (!row) return [];
      const payload = payloadById.get(id);
      if (!payload?.metadata) return [];
      return [{
        id,
        vector: vectorValues(row.vector),
        payload: {
          key: payload?.key ?? id,
          ...(payload?.metadata ? { metadata: payload.metadata } : {}),
        },
      }];
    });
  }

  async getStats(): Promise<{ vectorCount: number; dbSize: string }> {
    const stats = await this.currentTable().stats();
    vectorCount.set(stats.numRows);
    await this.updateIndexMetrics();
    return {
      vectorCount: stats.numRows,
      dbSize: `${(stats.totalBytes / 1024 ** 3).toFixed(2)} GB`,
    };
  }

  async close(): Promise<void> {
    if (this.optimizePromise) await this.optimizePromise;
    this.table?.close();
    this.connection?.close();
    await this.tweets.close();
    this.table = undefined;
    this.connection = undefined;
  }
}
