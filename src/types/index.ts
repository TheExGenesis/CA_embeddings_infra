export interface EmbeddingVector {
  key: string;
  vector: Float32Array;
  metadata?: Record<string, any>;
}

export interface SearchResult {
  key: string;
  distance: number;
  metadata?: Record<string, any>;
  vector?: number[];  // Original vector when with_vector=true
}

// ============================================================================
// Filter Types for Advanced Search (Qdrant-style)
// ============================================================================

/**
 * Match condition for exact value or text matching
 */
export interface MatchCondition {
  /** Exact value match (for strings, numbers, booleans) */
  value?: string | number | boolean;
  /** Full-text substring match (for text fields) */
  text?: string;
}

/**
 * Range condition for numeric and datetime filtering
 * Supports: gt (>), gte (>=), lt (<), lte (<=)
 * Datetime values can be ISO 8601 strings or Unix timestamps (milliseconds)
 */
export interface RangeCondition {
  /** Greater than */
  gt?: number | string;
  /** Greater than or equal */
  gte?: number | string;
  /** Less than */
  lt?: number | string;
  /** Less than or equal */
  lte?: number | string;
}

/**
 * A single filter condition targeting a metadata field
 */
export interface FieldCondition {
  /** The metadata field key to filter on (e.g., "tokens", "provider", "created_at") */
  key: string;
  /** Match condition for exact or text matching */
  match?: MatchCondition;
  /** Range condition for numeric or datetime filtering */
  range?: RangeCondition;
}

/**
 * Filter clause supporting AND (must), OR (should), and NOT (must_not) logic
 * Supports recursive nesting for complex queries
 */
export interface Filter {
  /** AND logic - all conditions must match */
  must?: FilterItem[];
  /** OR logic - at least one condition must match */
  should?: FilterItem[];
  /** NOT logic - none of the conditions must match */
  must_not?: FilterItem[];
}

/**
 * A filter item can be either a field condition or a nested filter clause
 */
export type FilterItem = FieldCondition | Filter;

/**
 * Legacy flat filter format for backward compatibility
 * Keys are metadata field names, values are filter expressions
 * Examples: { "tokens": ">50", "provider": "deepinfra", "is_truncated": false }
 */
export type LegacyFilter = Record<string, any>;

/**
 * Combined filter type supporting both new clause-based and legacy flat formats
 */
export type SearchFilter = Filter | LegacyFilter;

// ============================================================================
// Search Types
// ============================================================================

export interface SearchQuery {
  vector: Float32Array;
  k: number;
  threshold?: number;
  /** Filter supporting both new clause-based format and legacy flat format */
  filter?: SearchFilter;
  /** Return original vectors in results (default: false) */
  with_vector?: boolean;
  /** Return metadata/payload in results (default: true) */
  with_payload?: boolean;
}

export type VectorStoreType = 'qdrant' | 'clickhouse';

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  port: number;
  collectionName: string;
  timeout?: number;
}

export interface ClickHouseConfig {
  url: string;
  user: string;
  password?: string;
  database: string;
  vectorTable: string;
  payloadTable: string;
  timeout?: number;
  searchCandidates?: number;
}

export interface DatabaseConfig {
  type: VectorStoreType;
  dimension: number;
  // Qdrant-specific config
  qdrant?: QdrantConfig;
  // ClickHouse-specific config
  clickhouse?: ClickHouseConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
  environment: 'development' | 'production' | 'test';
}

export interface ObservabilityConfig {
  enableMetrics: boolean;
  metricsPort: number;
  enableTracing: boolean;
  otlpEndpoint?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface SecurityConfig {
  corsOrigin: string;
  helmetEnabled: boolean;
  apiKeys: string[];
}

export interface EmbeddingProviderConfig {
  provider: 'deepinfra' | 'openai' | 'local';
  apiKey?: string;
  model: string;
  endpoint?: string;
  timeout?: number;
  retries?: number;
}

export interface EmbeddingGenerationConfig {
  enabled: boolean;
  storage: {
    enabled: boolean;
    path?: string;
  };
  provider: EmbeddingProviderConfig;
  queue?: {
    maxParallelFiles?: number;      // Keep for batch processing (deprecated for SQLite queue)
    insertChunkSize?: number;        // Chunk size for vector store inserts
    maxFilesRetained?: number;       // Deprecated for SQLite queue
    sqliteDbPath?: string;           // SQLite database path
  };
}

export interface GenerateEmbeddingsRequest {
  items: EmbeddingGenerationItem[];
}

export interface EmbeddingGenerationItem {
  key: string;
  content: string | ImageContent;
  contentType: 'text' | 'image';
  metadata?: Record<string, any>;
}

export interface ImageContent {
  data: Buffer;
  mimeType: string;
}

export interface GenerateEmbeddingsResponse {
  success: boolean;
  results?: GeneratedEmbedding[];
  error?: string;
  generated: number;
}

export interface GeneratedEmbedding {
  key: string;
  vector: number[];
  metadata?: Record<string, any>;
}

export interface EmbeddingProviderResponse {
  embeddings: Array<{
    embedding: number[];
    index: number;
  }>;
  usage: {
    total_tokens: number;
    prompt_tokens: number;
  };
}

export interface StoredEmbeddingCall {
  id: string;
  timestamp: Date;
  provider: string;
  model: string;
  inputTokens: number;
  outputDimension: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

export interface SupabaseConfig {
  enabled: boolean;
  url: string;
  anonKey?: string;
  serviceRoleKey?: string;
  storageBucket?: string;
  maxTextLength?: number;
  batchSize?: number;
  flushTimeoutMs?: number;
}

export interface R2Config {
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  backupIntervalDays: number;
}

export interface R2ExportResult {
  success: boolean;
  latestPath?: string;
  archivePath?: string;
  pointsExported: number;
  durationMs: number;
  error?: string;
}

export interface AppConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  observability: ObservabilityConfig;
  rateLimit: RateLimitConfig;
  security: SecurityConfig;
  embeddingGeneration?: EmbeddingGenerationConfig;
  supabase?: SupabaseConfig;
  r2?: R2Config;
}
