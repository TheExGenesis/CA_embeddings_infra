import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { appConfig } from '../config/index.js';

// Create a custom registry
export const register = new Registry();

// Collect default metrics (CPU, memory, etc.)
if (appConfig.observability.enableMetrics) {
  collectDefaultMetrics({ register });
}

// Initialize metrics (no-op now, kept for API compatibility)
export async function initializeMetrics(): Promise<void> {
  // No initialization needed for prom-client
}

export async function closeMetrics(): Promise<void> {
  // No cleanup needed for prom-client
}

// HTTP metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.001, 0.005, 0.015, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 1],
  registers: [register],
});

export const activeConnections = new Gauge({
  name: 'active_connections',
  help: 'Number of active connections',
  registers: [register],
});

// Embedding operation metrics
export const embeddingOperationDuration = new Histogram({
  name: 'embedding_operation_duration_seconds',
  help: 'Duration of embedding operations in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const vectorCount = new Gauge({
  name: 'vector_count_total',
  help: 'Total number of vectors stored',
  registers: [register],
});

export const searchAccuracy = new Histogram({
  name: 'search_accuracy_score',
  help: 'Search accuracy scores',
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0],
  registers: [register],
});

export const errorRate = new Counter({
  name: 'errors_total',
  help: 'Total number of errors',
  labelNames: ['type', 'operation'],
  registers: [register],
});

// Vector store operation counters
export const vectorStoreOperationsTotal = new Counter({
  name: 'vector_store_operations_total',
  help: 'Total vector store operations by type and status',
  labelNames: ['operation', 'status'],
  registers: [register],
});

export const vectorStoreItemsProcessed = new Counter({
  name: 'vector_store_items_processed_total',
  help: 'Total items processed by operation type',
  labelNames: ['operation'],
  registers: [register],
});

export const vectorStoreBatchSize = new Histogram({
  name: 'vector_store_batch_size',
  help: 'Size of batches processed',
  labelNames: ['operation'],
  buckets: [1, 10, 50, 100, 500, 1000, 5000, 10000],
  registers: [register],
});

// Search quality metrics
export const searchResultsCount = new Histogram({
  name: 'search_results_count',
  help: 'Number of results returned per search',
  buckets: [0, 1, 5, 10, 25, 50, 100, 500, 1000],
  registers: [register],
});

export const embeddingDimension = new Gauge({
  name: 'embedding_dimension_size',
  help: 'Configured embedding dimension size',
  registers: [register],
});

// Collection statistics
export const collectionVectorCount = new Gauge({
  name: 'collection_vector_count_total',
  help: 'Total vectors in collection',
  labelNames: ['collection'],
  registers: [register],
});

export const collectionIndexedPercentage = new Gauge({
  name: 'collection_indexed_percentage',
  help: 'Percentage of vectors indexed',
  labelNames: ['collection'],
  registers: [register],
});

export const lanceDbIndexedRows = new Gauge({
  name: 'lancedb_indexed_rows',
  help: 'Number of LanceDB rows covered by the active vector index',
  registers: [register],
});

export const lanceDbUnindexedRows = new Gauge({
  name: 'lancedb_unindexed_rows',
  help: 'Number of LanceDB rows not yet covered by the active vector index',
  registers: [register],
});

export const lanceDbScalarIndexedRows = new Gauge({
  name: 'lancedb_scalar_indexed_rows',
  help: 'Number of LanceDB rows covered by the id B-tree',
  registers: [register],
});

export const lanceDbScalarUnindexedRows = new Gauge({
  name: 'lancedb_scalar_unindexed_rows',
  help: 'Number of LanceDB rows not yet covered by the id B-tree',
  registers: [register],
});

export const lanceDbScalarIndexRefreshTotal = new Counter({
  name: 'lancedb_scalar_index_refresh_total',
  help: 'LanceDB id B-tree refresh operations by status',
  labelNames: ['status'],
  registers: [register],
});

export const lanceDbOptimizeTotal = new Counter({
  name: 'lancedb_optimize_total',
  help: 'LanceDB background optimize operations by status',
  labelNames: ['status'],
  registers: [register],
});

export const lanceDbFilteredSearchTotal = new Counter({
  name: 'lancedb_filtered_search_total',
  help: 'Filtered LanceDB searches evaluated against canonical tweet metadata',
  registers: [register],
});

export const lanceDbMutationTotal = new Counter({
  name: 'lancedb_mutation_total',
  help: 'LanceDB mutation attempts by operation and status',
  labelNames: ['operation', 'status'],
  registers: [register],
});

// Queue metrics
export const queueDepth = new Gauge({
  name: 'embedding_queue_depth',
  help: 'Current number of items in embedding queue',
  registers: [register],
});

export const queueProcessingRate = new Counter({
  name: 'embedding_queue_processed_total',
  help: 'Total embeddings processed from queue',
  labelNames: ['status'],
  registers: [register],
});

export const queueFileCount = new Gauge({
  name: 'embedding_queue_items',
  help: 'Number of queue items by status',
  labelNames: ['status'],
  registers: [register],
});

export const queueRetryCount = new Counter({
  name: 'embedding_queue_retries_total',
  help: 'Total number of queue item retries',
  registers: [register],
});

// Parquet export metrics
export const parquetBatchCount = new Gauge({
  name: 'embedding_queue_parquet_batches_total',
  help: 'Total number of Parquet batches created',
  registers: [register],
});

export const parquetExportSize = new Counter({
  name: 'embedding_queue_parquet_export_bytes_total',
  help: 'Total size of exported Parquet files in bytes',
  registers: [register],
});

export const metricsRegister = register;
