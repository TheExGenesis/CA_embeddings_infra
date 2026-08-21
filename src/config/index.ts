import { config } from 'dotenv';
import { z } from 'zod';
import type { AppConfig } from '../types/index.js';

config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Vector store configuration
  VECTOR_STORE: z.enum(['qdrant', 'clickhouse', 'lancedb']).default('qdrant'),
  VECTOR_DIMENSION: z.string().default('1024').transform(Number),

  // Qdrant-specific configuration
  QDRANT_URL: z.string().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_PORT: z.string().default('6333').transform(Number),
  QDRANT_COLLECTION_NAME: z.string().default('embeddings'),
  QDRANT_TIMEOUT: z.string().default('30000').transform(Number),

  // ClickHouse-specific configuration
  CLICKHOUSE_URL: z.string().default('http://localhost:8123'),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().optional(),
  CLICKHOUSE_DATABASE: z.string().default('vector_bench'),
  CLICKHOUSE_VECTOR_TABLE: z.string().default('vectors'),
  CLICKHOUSE_PAYLOAD_TABLE: z.string().default('payloads'),
  CLICKHOUSE_TIMEOUT: z.string().default('30000').transform(Number),
  CLICKHOUSE_SEARCH_CANDIDATES: z.string().default('256').transform(Number),

  // LanceDB-specific configuration.
  LANCEDB_URI: z.string().default('./data/lancedb'),
  LANCEDB_TABLE: z.string().default('vectors'),
  LANCEDB_NPROBES: z.string().default('64').transform(Number),
  LANCEDB_REFINE_FACTOR: z.string().default('2').transform(Number),
  LANCEDB_OPTIMIZE_AFTER_ROWS: z.string().default('100000').transform(Number),
  LANCEDB_OPTIMIZE_AFTER_MUTATIONS: z.string().default('1000').transform(Number),

  // Canonical tweet projection used for read-only payload hydration.
  TWEET_CLICKHOUSE_URL: z.string().default('http://localhost:18123'),
  TWEET_CLICKHOUSE_USER: z.string().default('default'),
  TWEET_CLICKHOUSE_PASSWORD: z.string().optional(),
  TWEET_CLICKHOUSE_DATABASE: z.string().default('community_archive'),
  TWEET_CLICKHOUSE_TIMEOUT: z.string().default('30000').transform(Number),
  TWEET_CLICKHOUSE_HYDRATION_BATCH_SIZE: z.string().default('100').transform(Number),
  LANCEDB_FILTER_CANDIDATES: z.string().default('256').transform(Number),

  ENABLE_METRICS: z.string().default('true').transform(val => val === 'true'),
  METRICS_PORT: z.string().default('9090').transform(Number),
  ENABLE_TRACING: z.string().default('true').transform(val => val === 'true'),
  OTLP_ENDPOINT: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  RATE_LIMIT_MAX: z.string().default('100').transform(Number),
  RATE_LIMIT_WINDOW: z.string().default('60000').transform(Number),

  CORS_ORIGIN: z.string().default('*'),
  HELMET_ENABLED: z.string().default('true').transform(val => val === 'true'),
  API_KEYS: z.string().optional().transform(val => val ? val.split(',').map(k => k.trim()) : []),

  EMBEDDING_GENERATION_ENABLED: z.string().default('false').transform(val => val === 'true'),
  EMBEDDING_PROVIDER: z.enum(['deepinfra', 'openai', 'local']).default('deepinfra'),
  EMBEDDING_MODEL: z.string().default('Qwen/Qwen3-Embedding-4B'),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_ENDPOINT: z.string().optional(),
  EMBEDDING_TIMEOUT: z.string().default('30000').transform(Number),
  EMBEDDING_RETRIES: z.string().default('2').transform(Number),
  EMBEDDING_STORAGE_ENABLED: z.string().default('true').transform(val => val === 'true'),
  EMBEDDING_STORAGE_PATH: z.string().default('./data/embedding-calls'),
  
  // Queue performance settings (deprecated, kept for backward compatibility)
  QUEUE_MAX_PARALLEL_FILES: z.string().default('5').transform(Number),
  QUEUE_INSERT_CHUNK_SIZE: z.string().default('1000').transform(Number),
  QUEUE_MAX_FILES_RETAINED: z.string().default('100').transform(Number),
  
  // SQLite Queue settings
  QUEUE_SQLITE_DB_PATH: z.string().optional(),
  
  // Supabase Listener settings
  SUPABASE_LISTENER_ENABLED: z.string().default('false').transform(val => val === 'true'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().optional(),
  SUPABASE_MAX_TEXT_LENGTH: z.string().default('30720').transform(Number),
  SUPABASE_BATCH_SIZE: z.string().default('1000').transform(Number),
  SUPABASE_FLUSH_TIMEOUT_MS: z.string().default('30000').transform(Number),

  // R2 Storage settings (for vector store backups)
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  BACKUP_INTERVAL_DAYS: z.string().default('7').transform(Number),
});

const env = envSchema.parse(process.env);

export const appConfig: AppConfig = {
  server: {
    port: env.PORT,
    host: env.HOST,
    environment: env.NODE_ENV,
  },
  database: {
    type: env.VECTOR_STORE,
    dimension: env.VECTOR_DIMENSION,
    // Qdrant-specific
    qdrant: {
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      port: env.QDRANT_PORT,
      collectionName: env.QDRANT_COLLECTION_NAME,
      timeout: env.QDRANT_TIMEOUT,
    },
    clickhouse: {
      url: env.CLICKHOUSE_URL,
      user: env.CLICKHOUSE_USER,
      password: env.CLICKHOUSE_PASSWORD,
      database: env.CLICKHOUSE_DATABASE,
      vectorTable: env.CLICKHOUSE_VECTOR_TABLE,
      payloadTable: env.CLICKHOUSE_PAYLOAD_TABLE,
      timeout: env.CLICKHOUSE_TIMEOUT,
      searchCandidates: env.CLICKHOUSE_SEARCH_CANDIDATES,
    },
    lancedb: {
      uri: env.LANCEDB_URI,
      table: env.LANCEDB_TABLE,
      nprobes: env.LANCEDB_NPROBES,
      refineFactor: env.LANCEDB_REFINE_FACTOR,
      optimizeAfterRows: env.LANCEDB_OPTIMIZE_AFTER_ROWS,
      optimizeAfterMutations: env.LANCEDB_OPTIMIZE_AFTER_MUTATIONS,
    },
    tweetClickhouse: {
      url: env.TWEET_CLICKHOUSE_URL,
      user: env.TWEET_CLICKHOUSE_USER,
      password: env.TWEET_CLICKHOUSE_PASSWORD,
      database: env.TWEET_CLICKHOUSE_DATABASE,
      timeout: env.TWEET_CLICKHOUSE_TIMEOUT,
      hydrationBatchSize: env.TWEET_CLICKHOUSE_HYDRATION_BATCH_SIZE,
      filterCandidates: env.LANCEDB_FILTER_CANDIDATES,
    },
  },
  observability: {
    enableMetrics: env.ENABLE_METRICS,
    metricsPort: env.METRICS_PORT,
    enableTracing: env.ENABLE_TRACING,
    otlpEndpoint: env.OTLP_ENDPOINT,
    logLevel: env.LOG_LEVEL,
  },
  rateLimit: {
    max: env.RATE_LIMIT_MAX,
    windowMs: env.RATE_LIMIT_WINDOW,
  },
  security: {
    corsOrigin: env.CORS_ORIGIN,
    helmetEnabled: env.HELMET_ENABLED,
    apiKeys: env.API_KEYS,
  },
  embeddingGeneration: {
    enabled: env.EMBEDDING_GENERATION_ENABLED,
    storage: {
      enabled: env.EMBEDDING_STORAGE_ENABLED,
      path: env.EMBEDDING_STORAGE_PATH,
    },
    provider: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      apiKey: env.EMBEDDING_API_KEY,
      endpoint: env.EMBEDDING_ENDPOINT,
      timeout: env.EMBEDDING_TIMEOUT,
      retries: env.EMBEDDING_RETRIES,
    },
    queue: {
      maxParallelFiles: env.QUEUE_MAX_PARALLEL_FILES,
      insertChunkSize: env.QUEUE_INSERT_CHUNK_SIZE,
      maxFilesRetained: env.QUEUE_MAX_FILES_RETAINED,
      sqliteDbPath: env.QUEUE_SQLITE_DB_PATH,
    },
  },
  supabase: env.SUPABASE_URL ? {
    enabled: env.SUPABASE_LISTENER_ENABLED,
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: env.SUPABASE_STORAGE_BUCKET,
    maxTextLength: env.SUPABASE_MAX_TEXT_LENGTH,
    batchSize: env.SUPABASE_BATCH_SIZE,
    flushTimeoutMs: env.SUPABASE_FLUSH_TIMEOUT_MS,
  } : undefined,
  r2: env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT && env.R2_BUCKET ? {
    enabled: true,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    backupIntervalDays: env.BACKUP_INTERVAL_DAYS,
  } : undefined,
};

export default appConfig;
