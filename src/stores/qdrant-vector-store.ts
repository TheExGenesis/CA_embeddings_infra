import { QdrantClient } from '@qdrant/js-client-rest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { 
  EmbeddingVector, 
  SearchResult, 
  SearchQuery, 
  DatabaseConfig,
  Filter,
  FilterItem,
  FieldCondition,
  RangeCondition
} from '../types/index.js';
import { createContextLogger } from '../observability/logger.js';
import { embeddingOperationDuration, errorRate } from '../observability/metrics.js';
import type { IVectorStore } from '../interfaces/vector-store.interface.js';
import { cleanTweetText } from '../utils/tweet-text-processor.js';

const tracer = trace.getTracer('qdrant-vector-store');

/**
 * Qdrant implementation of the vector store interface
 * Uses Qdrant as the underlying vector database with advanced features
 */
export class QdrantVectorStore implements IVectorStore {
  private client: QdrantClient | null = null;
  private config: DatabaseConfig;
  private collectionName: string;
  private isInitialized = false;

  constructor(config: DatabaseConfig) {
    this.config = config;

    if (!config.qdrant) {
      throw new Error('Qdrant configuration is required for QdrantVectorStore');
    }

    this.collectionName = config.qdrant.collectionName;
  }

  async initialize(): Promise<void> {
    const span = tracer.startSpan('qdrant_vector_store_initialize');
    const contextLogger = createContextLogger({ operation: 'initialize', store: 'qdrant' });

    try {
      const qdrantConfig = this.config.qdrant!;

      contextLogger.info({
        url: qdrantConfig.url,
        port: qdrantConfig.port,
        collection: this.collectionName,
        dimension: this.config.dimension

      }, 'Initializing Qdrant client');

      // Initialize Qdrant client
      this.client = new QdrantClient({
        url: qdrantConfig.url,
        apiKey: qdrantConfig.apiKey,
        port: qdrantConfig.port,
        timeout: qdrantConfig.timeout || 30000,
      });

      // Check if collection exists
      const collections = await this.client.getCollections();
      const collectionExists = collections.collections.some(
        col => col.name === this.collectionName
      );

      if (!collectionExists) {
        contextLogger.info('Collection does not exist, creating new collection');

        // Create collection with proper vector configuration
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.config.dimension,
            distance: 'Cosine', // Default to Cosine similarity
          },
          // Enable payload indexing for metadata filtering
          optimizers_config: {
            indexing_threshold: 10000,
          },
        });

        contextLogger.info('Created new Qdrant collection');
      } else {
        contextLogger.info('Using existing Qdrant collection');

        // Verify collection configuration
        const collectionInfo = await this.client.getCollection(this.collectionName);
        const vectorsConfig = collectionInfo.config?.params?.vectors;
        const vectorSize = typeof vectorsConfig === 'object' && 'size' in vectorsConfig
          ? vectorsConfig.size
          : 0;

        if (vectorSize !== this.config.dimension) {
          throw new Error(
            `Collection dimension mismatch: expected ${this.config.dimension}, got ${vectorSize}`
          );
        }
      }

      // Ensure payload indexes exist for text fields (works for both new and existing collections)
      await this.ensurePayloadIndexes(contextLogger);

      // Ensure quantization is configured for optimal search performance
      await this.ensureQuantizationConfig(contextLogger);

      this.isInitialized = true;
      contextLogger.info('Qdrant client initialized successfully');
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to initialize Qdrant client');
      errorRate.inc({ type: 'database', operation: 'initialize' });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      throw error;
    } finally {
      span.end();
    }
  }

  async insert(embeddings: EmbeddingVector[]): Promise<void> {
    this.ensureInitialized();

    const span = tracer.startSpan('qdrant_vector_store_insert');
    const timer = embeddingOperationDuration.startTimer({ operation: 'insert' });
    const contextLogger = createContextLogger({
      operation: 'insert',
      store: 'qdrant',
      count: embeddings.length
    });

    try {
      contextLogger.info('Starting bulk insert operation');

      // Convert embeddings to Qdrant points format
      // Note: Qdrant's TypeScript types don't include bigint, but it works at runtime
      // We use 'as any' to bypass the type check since BigInt is required for large tweet IDs
      const points = embeddings.map((emb, index) => {
        // Use BigInt ID for Qdrant to preserve precision for large tweet IDs (19+ digits)
        // Number.MAX_SAFE_INTEGER is only ~16 digits, causing precision loss for tweet IDs
        // Qdrant accepts BigInt IDs which preserves full precision
        // Note: String IDs are only valid if they're UUIDs; numeric strings cause "Bad Request"
        const bigIntId = BigInt(emb.key);

        return {
          id: bigIntId as any, // Use BigInt for Qdrant to preserve precision (type assertion needed)
          vector: Array.from(emb.vector), // Qdrant expects array, not Float32Array
          payload: {
            key: emb.key, // Keep original string key in payload for retrieval
            metadata: emb.metadata || {}, // Keep metadata nested
          },
        };
      });

      // Batch upsert for performance
      await this.client!.upsert(this.collectionName, {
        wait: true,
        points,
      });

      contextLogger.info('Bulk insert completed successfully');
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to insert embeddings');
      errorRate.inc({ type: 'database', operation: 'insert' });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      throw error;
    } finally {
      timer();
      span.end();
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureInitialized();

    const span = tracer.startSpan('qdrant_vector_store_exists');
    const contextLogger = createContextLogger({
      operation: 'exists',
      store: 'qdrant',
      key
    });

    try {
      // Use BigInt ID (same format used for insertion) to preserve precision for large tweet IDs
      const bigIntId = BigInt(key);

      contextLogger.debug({ key }, 'Checking if vector exists');

      // Retrieve the point without payload or vector data for efficiency
      // Note: Qdrant's TypeScript types don't include bigint, but it works at runtime
      const result = await this.client!.retrieve(this.collectionName, {
        ids: [bigIntId as any], // Type assertion needed for BigInt
        with_payload: false,
        with_vector: false
      });

      const exists = result.length > 0;
      contextLogger.debug({ exists }, 'Vector existence check completed');
      
      span.setStatus({ code: SpanStatusCode.OK });
      return exists;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to check vector existence');
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      // Return false on error rather than throwing
      return false;
    } finally {
      span.end();
    }
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.ensureInitialized();

    const span = tracer.startSpan('qdrant_vector_store_search');
    const timer = embeddingOperationDuration.startTimer({ operation: 'search' });
    const contextLogger = createContextLogger({
      operation: 'search',
      store: 'qdrant',
      k: query.k,
      hasFilter: !!query.filter
    });

    try {
      contextLogger.debug('Starting vector search');

      // Build Qdrant filter if provided (supports both new and legacy formats)
      const filter = query.filter ? this.buildQdrantFilter(query.filter) : undefined;

      if (filter) {
        contextLogger.debug({ filter }, 'Applying metadata filter to search');
      }
      

      const withPayload = query.with_payload ?? true;
      const withVector = query.with_vector ?? false;

      const searchResults = await this.client!.search(this.collectionName, {
        vector: Array.from(query.vector),
        limit: query.k,
        filter,
        with_payload: withPayload,
        with_vector: withVector,
        score_threshold: query.threshold,
        params: {
          hnsw_ef: 128,
          quantization: {
            rescore: true,
            oversampling: 2,
          },
        },
      });

      const results: SearchResult[] = searchResults.map(result => {
        // Extract and flatten metadata from payload
        // Payload structure: { key: string, metadata: {...}, ...otherFields }
        let key: string;
        let metadata: Record<string, any> | undefined;

        if (result.payload) {
          const sanitizedPayload = this.sanitizeMetadata(result.payload);
          const { key: payloadKey, metadata: nestedMetadata } = sanitizedPayload;

          // Use the original string key from payload (not the numeric ID)
          // This preserves the full precision of large numeric keys
          key = payloadKey as string;

          metadata = withPayload ? {
            ...nestedMetadata,
          } : undefined;
        } else {
          // Fallback to ID if no payload (shouldn't happen in normal operation)
          const id = result.id;
          key = typeof id === 'bigint' ? (id as bigint).toString() : String(id);
        }

        // Include vector if requested and available
        const vector = withVector && result.vector
          ? Array.from(result.vector as number[])
          : undefined;

        return {
          key,
          distance: result.score,
          metadata,
          vector,
        };
      });

      contextLogger.info({
        resultCount: results.length,
        queryTime: timer()
      }, 'Vector search completed');

      span.setStatus({ code: SpanStatusCode.OK });
      return results;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to search embeddings');
      errorRate.inc({ type: 'database', operation: 'search' });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      throw error;
    } finally {
      timer();
      span.end();
    }
  }

  /**
   * Ensure payload indexes exist for common fields
   * Checks if indexes already exist before creating them
   */
  private async ensurePayloadIndexes(contextLogger: any): Promise<void> {
    try {
      // Get existing collection info to check for existing indexes
      const collectionInfo = await this.client!.getCollection(this.collectionName);
      const existingIndexes = collectionInfo.payload_schema || {};

      // Define indexes to create
      const textIndexes = [
        { field: 'metadata.text', schema: 'text' },
        { field: 'metadata.original_text', schema: 'text' },
      ];

      const keywordIndexes = [
        { field: 'metadata.source', schema: 'keyword' },
        { field: 'metadata.provider', schema: 'keyword' },
        { field: 'metadata.model', schema: 'keyword' },
      ];

      const allIndexes = [...textIndexes, ...keywordIndexes];

      // Create missing indexes
      for (const { field, schema } of allIndexes) {
        // Check if index already exists
        if (existingIndexes[field]) {
          contextLogger.debug(`Payload index for ${field} already exists`);
          continue;
        }

        try {
          await this.client!.createPayloadIndex(this.collectionName, {
            field_name: field,
            field_schema: schema as any,
          });
          contextLogger.info(`Created payload index for ${field}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          contextLogger.warn(`Failed to create ${field} field index: ${errorMessage}`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.warn(`Failed to ensure payload indexes: ${errorMessage}`);
    }
  }

  /**
   * Desired quantization configuration for optimal search performance.
   * Binary quantization with 2-bit encoding provides a good balance between
   * compression (16x) and recall accuracy, while fitting in available RAM.
   */
  private static readonly DESIRED_QUANTIZATION_CONFIG = {
    binary: {
      always_ram: true,
      // 2-bit encoding: 16x compression with better recall than 1-bit
      // Alternatives: undefined (1-bit, 32x), 'one_and_half_bits' (24x)
      // encoding: 'two_bits' as const,
    },
  };

  /**
   * Ensure quantization is configured for optimal search performance.
   * Checks current config and updates if needed (only logs warning, doesn't auto-update
   * because quantization changes trigger re-indexing which can take significant time).
   */
  private async ensureQuantizationConfig(contextLogger: any): Promise<void> {
    try {
      const collectionInfo = await this.client!.getCollection(this.collectionName);
      const currentConfig = collectionInfo.config?.quantization_config;

      // Check if quantization is configured
      if (!currentConfig) {
        contextLogger.warn(
          'Quantization is not configured. For optimal search performance, enable binary quantization. '
        );
        return;
      }

      // Log current quantization config
      if ('binary' in currentConfig) {
        const binaryConfig = currentConfig.binary as any;
        const encoding = binaryConfig?.encoding || '1-bit (default)';
        const alwaysRam = binaryConfig?.always_ram ?? false;
        contextLogger.info({
          type: 'binary',
          encoding,
          always_ram: alwaysRam,
        }, 'Quantization configured');
      } else if ('scalar' in currentConfig) {
        const scalarConfig = currentConfig.scalar as any;
        contextLogger.info({
          type: 'scalar',
          scalar_type: scalarConfig?.type,
          quantile: scalarConfig?.quantile,
          always_ram: scalarConfig?.always_ram ?? false,
        }, 'Quantization configured');
      } else if ('product' in currentConfig) {
        const productConfig = currentConfig.product as any;
        contextLogger.info({
          type: 'product',
          compression: productConfig?.compression,
          always_ram: productConfig?.always_ram ?? false,
        }, 'Quantization configured');
      }

      // Note: We intentionally don't auto-update quantization config because:
      // 1. Changing quantization triggers re-indexing (can take 10-30+ minutes for 9M vectors)
      // 2. This should be a deliberate decision by the operator
      // 3. The current config might be intentional (e.g., testing different settings)
      //
      // To update quantization, use the Qdrant API directly:
      // PUT /collections/{collection}/
      // { "quantization_config": { "binary": { "always_ram": true, "encoding": "two_bits" } } }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.warn(`Failed to check quantization config: ${errorMessage}`);
    }
  }

  // ============================================================================
  // Filter Building Methods (Qdrant-style with must/should/must_not)
  // ============================================================================

  /**
   * Parse datetime value from ISO 8601 string or Unix timestamp
   * Returns Unix timestamp in seconds for Qdrant datetime range queries
   */
  private parseDatetimeValue(value: string | number): number {
    if (typeof value === 'number') {
      // If value is already a number, assume it's a Unix timestamp
      // If it looks like milliseconds (> year 2100 in seconds), convert to seconds
      if (value > 4102444800) {
        return Math.floor(value / 1000);
      }
      return value;
    }

    // Try to parse as ISO 8601 datetime string
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1000);
    }

    // If not a valid datetime, try parsing as a number string
    const numValue = parseFloat(value);
    if (!isNaN(numValue)) {
      if (numValue > 4102444800) {
        return Math.floor(numValue / 1000);
      }
      return numValue;
    }

    throw new Error(`Invalid datetime value: ${value}`);
  }

  /**
   * Check if a value looks like a datetime (ISO 8601 string or large timestamp)
   */
  private isDatetimeValue(value: string | number): boolean {
    if (typeof value === 'string') {
      // Check for ISO 8601 format patterns
      const isoPattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;
      if (isoPattern.test(value)) {
        const date = new Date(value);
        return !isNaN(date.getTime());
      }
      return false;
    }
    // Large numbers (> year 2000 in seconds) are likely timestamps
    return value > 946684800;
  }

  /**
   * Build a range condition for Qdrant
   * Handles both numeric and datetime values
   */
  private buildRangeCondition(range: RangeCondition): any {
    const qdrantRange: any = {};

    // Check if any value looks like a datetime
    const values = [range.gt, range.gte, range.lt, range.lte].filter(v => v !== undefined);
    const isDatetime = values.some(v => this.isDatetimeValue(v!));

    if (range.gt !== undefined) {
      qdrantRange.gt = isDatetime ? this.parseDatetimeValue(range.gt) : 
        (typeof range.gt === 'string' ? parseFloat(range.gt) : range.gt);
    }
    if (range.gte !== undefined) {
      qdrantRange.gte = isDatetime ? this.parseDatetimeValue(range.gte) : 
        (typeof range.gte === 'string' ? parseFloat(range.gte) : range.gte);
    }
    if (range.lt !== undefined) {
      qdrantRange.lt = isDatetime ? this.parseDatetimeValue(range.lt) : 
        (typeof range.lt === 'string' ? parseFloat(range.lt) : range.lt);
    }
    if (range.lte !== undefined) {
      qdrantRange.lte = isDatetime ? this.parseDatetimeValue(range.lte) : 
        (typeof range.lte === 'string' ? parseFloat(range.lte) : range.lte);
    }

    return qdrantRange;
  }

  /**
   * Check if an object is a FieldCondition (has 'key' property)
   */
  private isFieldCondition(item: FilterItem): item is FieldCondition {
    return 'key' in item;
  }

  /**
   * Build a single Qdrant condition from a FieldCondition
   */
  private buildCondition(condition: FieldCondition): any {
    // Prefix with 'metadata.' to match the payload structure
    const filterKey = `metadata.${condition.key}`;

    if (condition.match) {
      if (condition.match.text !== undefined) {
        // Full-text substring matching
        // Apply the same text cleaning as used when storing tweets
        // This ensures filters match against the processed/cleaned text
        const cleanedText = cleanTweetText(condition.match.text);
        return {
          key: filterKey,
          match: { text: cleanedText },
        };
      } else if (condition.match.value !== undefined) {
        // Exact value matching
        return {
          key: filterKey,
          match: { value: condition.match.value },
        };
      }
    }

    if (condition.range) {
      return {
        key: filterKey,
        range: this.buildRangeCondition(condition.range),
      };
    }

    throw new Error(`Invalid condition: must have either 'match' or 'range'`);
  }

  /**
   * Build Qdrant filter from Filter object with must/should/must_not clauses
   * Supports recursive nesting of filter clauses
   */
  private buildFilter(filter: Filter): any {
    const qdrantFilter: any = {};

    if (filter.must && filter.must.length > 0) {
      qdrantFilter.must = filter.must.map(item => {
        if (this.isFieldCondition(item)) {
          return this.buildCondition(item);
        } else {
          // Nested filter clause
          return this.buildFilter(item as Filter);
        }
      });
    }

    if (filter.should && filter.should.length > 0) {
      qdrantFilter.should = filter.should.map(item => {
        if (this.isFieldCondition(item)) {
          return this.buildCondition(item);
        } else {
          // Nested filter clause
          return this.buildFilter(item as Filter);
        }
      });
    }

    if (filter.must_not && filter.must_not.length > 0) {
      qdrantFilter.must_not = filter.must_not.map(item => {
        if (this.isFieldCondition(item)) {
          return this.buildCondition(item);
        } else {
          // Nested filter clause
          return this.buildFilter(item as Filter);
        }
      });
    }

    return qdrantFilter;
  }

  // ============================================================================
  // Legacy Filter Support (Backward Compatibility)
  // ============================================================================

  /**
   * Check if a filter object is using the new clause-based format
   */
  private isClauseBasedFilter(filter: any): boolean {
    if (!filter || typeof filter !== 'object') return false;
    const keys = Object.keys(filter);
    // New format has must, should, or must_not at top level
    return keys.some(key => ['must', 'should', 'must_not'].includes(key));
  }

  /**
   * Parse numeric range expression from string (legacy format)
   * Supports: ">10", "<50", ">=10", "<=50", ">10 & <50", ">=10 & <=50"
   */
  private parseNumericRange(value: string): { range?: any; isRange: boolean } {
    // Try to parse range expression
    const rangePattern = /^\s*(>=?|<=?)\s*(-?\d+(?:\.\d+)?)\s*(?:&\s*(>=?|<=?)\s*(-?\d+(?:\.\d+)?))?\s*$/;
    const match = value.match(rangePattern);

    if (!match) {
      return { isRange: false };
    }

    const op1 = match[1];
    const val1 = match[2];
    const op2 = match[3];
    const val2 = match[4];
    const range: any = {};

    // Parse first operator (always present if regex matched)
    if (op1 && val1) {
      const numVal = parseFloat(val1);
      if (op1 === '>') {
        range.gt = numVal;
      } else if (op1 === '>=') {
        range.gte = numVal;
      } else if (op1 === '<') {
        range.lt = numVal;
      } else if (op1 === '<=') {
        range.lte = numVal;
      }
    }

    // Parse second operator if exists (for range expressions like ">10 & <50")
    if (op2 && val2) {
      const numVal = parseFloat(val2);
      if (op2 === '>') {
        range.gt = numVal;
      } else if (op2 === '>=') {
        range.gte = numVal;
      } else if (op2 === '<') {
        range.lt = numVal;
      } else if (op2 === '<=') {
        range.lte = numVal;
      }
    }

    return { range, isRange: true };
  }

  /**
   * Build Qdrant filter from legacy flat key-value metadata format
   * Supports:
   * - Exact matching for non-string values (numbers, booleans)
   * - Substring matching for string values using full-text search
   * - Range queries for numeric fields (">10", "<50", ">10 & <50")
   */
  private buildLegacyFilter(metadata: Record<string, any>): any {
    const must = Object.entries(metadata).map(([key, value]) => {
      // Prefix with 'metadata.' to match the payload structure
      const filterKey = `metadata.${key}`;

      // Handle string values
      if (typeof value === 'string') {
        // Check if it's a numeric range expression
        const { range, isRange } = this.parseNumericRange(value);

        if (isRange) {
          // Use range filter for numeric ranges
          return {
            key: filterKey,
            range,
          };
        } else {
          // Use text matching for regular strings (enables substring matching)
          // Apply the same text cleaning as used when storing tweets
          // This ensures filters match against the processed/cleaned text
          const cleanedText = cleanTweetText(value);
          return {
            key: filterKey,
            match: { text: cleanedText },
          };
        }
      } else {
        // Use value matching for other types (exact matching)
        return {
          key: filterKey,
          match: { value },
        };
      }
    });

    return {
      must,
    };
  }

  /**
   * Build Qdrant filter from either new clause-based or legacy flat format
   * Automatically detects the format and routes to the appropriate handler
   */
  private buildQdrantFilter(filter: any): any {
    if (this.isClauseBasedFilter(filter)) {
      // New clause-based format (must/should/must_not)
      return this.buildFilter(filter as Filter);
    } else {
      // Legacy flat format (key-value pairs)
      return this.buildLegacyFilter(filter);
    }
  }

  /**
   * Sanitize metadata by converting BigInt values to strings
   * This is needed because JSON.stringify cannot serialize BigInt
   */
  private sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'bigint') {
        sanitized[key] = value.toString();
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeMetadata(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map(item => 
          typeof item === 'bigint' ? item.toString() :
          item && typeof item === 'object' ? this.sanitizeMetadata(item) :
          item
        );
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  async delete(keys: string[]): Promise<void> {
    this.ensureInitialized();

    const span = tracer.startSpan('qdrant_vector_store_delete');
    const timer = embeddingOperationDuration.startTimer({ operation: 'delete' });
    const contextLogger = createContextLogger({
      operation: 'delete',
      store: 'qdrant',
      count: keys.length
    });

    try {
      contextLogger.info('Starting bulk delete operation');

      // Convert string keys to BigInt IDs for Qdrant
      // Note: Qdrant's TypeScript types don't include bigint, but it works at runtime
      const bigIntIds = keys.map(key => BigInt(key) as any);

      // Delete points by IDs
      await this.client!.delete(this.collectionName, {
        wait: true,
        points: bigIntIds,
      });

      contextLogger.info('Bulk delete completed successfully');
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to delete embeddings');
      errorRate.inc({ type: 'database', operation: 'delete' });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      throw error;
    } finally {
      timer();
      span.end();
    }
  }

  /**
   * Update metadata for existing vectors without modifying the vectors themselves
   * Uses Qdrant's batchUpdate API for efficient bulk metadata-only updates
   * @param updates - Array of { key, metadata } to update
   * @returns Object with updated and failed counts
   */
  async updateMetadata(updates: Array<{ key: string; metadata: Record<string, any> }>): Promise<{ updated: number; failed: number }> {
    this.ensureInitialized();

    const span = tracer.startSpan('qdrant_vector_store_update_metadata');
    const timer = embeddingOperationDuration.startTimer({ operation: 'update_metadata' });
    const contextLogger = createContextLogger({
      operation: 'update_metadata',
      store: 'qdrant',
      count: updates.length
    });

    let updated = 0;
    let failed = 0;

    try {
      contextLogger.info('Starting bulk metadata update operation');

      // Process in larger batches using batchUpdate API (single HTTP request per batch)
      // Qdrant can handle ~1000 operations per batchUpdate call efficiently
      const BATCH_SIZE = 1000;
      
      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);

        // Build array of SetPayloadOperation for batchUpdate
        // Use BigInt IDs to preserve precision for large tweet IDs
        // Note: Qdrant's TypeScript types don't include bigint, but it works at runtime
        const operations: Array<{ set_payload: { payload: Record<string, any>; points: any[] } }> = [];

        for (const update of batch) {
          // Use BigInt ID to preserve precision
          const bigIntId = BigInt(update.key);

          operations.push({
            set_payload: {
              payload: {
                key: update.key, // Preserve original string key in payload
                metadata: update.metadata,
              },
              points: [bigIntId as any],
            }
          });
        }

        try {
          // Use batchUpdate to send all operations in a single HTTP request
          // This is MUCH faster than individual setPayload calls
          await this.client!.batchUpdate(this.collectionName, {
            wait: true,
            operations,
          });
          updated += batch.length;
        } catch (error) {
          // If batch fails, fall back to individual updates to identify which ones failed
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          contextLogger.warn({ error: errorMessage, batchStart: i, batchSize: batch.length }, 
            'Batch update failed, falling back to individual updates');
          
          for (const op of operations) {
            try {
              await this.client!.setPayload(this.collectionName, {
                wait: true,
                points: op.set_payload.points,
                payload: op.set_payload.payload,
              });
              updated++;
            } catch (individualError) {
              failed++;
              const individualErrorMessage = individualError instanceof Error ? individualError.message : 'Unknown error';
              contextLogger.warn({ key: op.set_payload.payload.key, error: individualErrorMessage }, 
                'Failed to update metadata for point');
            }
          }
        }

        // Log progress for large updates
        if (updates.length > BATCH_SIZE && (i + BATCH_SIZE) % (BATCH_SIZE * 10) === 0) {
          contextLogger.info({
            progress: Math.min(i + BATCH_SIZE, updates.length),
            total: updates.length,
            updated,
            failed
          }, 'Metadata update progress');
        }
      }

      contextLogger.info({ updated, failed }, 'Bulk metadata update completed');
      span.setStatus({ code: SpanStatusCode.OK });
      
      return { updated, failed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage, updated, failed }, 'Failed to complete metadata update');
      errorRate.inc({ type: 'database', operation: 'update_metadata' });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      throw error;
    } finally {
      timer();
      span.end();
    }
  }

  async getStats(): Promise<{ vectorCount: number; dbSize: string }> {
    this.ensureInitialized();

    const span = tracer.startSpan('qdrant_vector_store_stats');
    const contextLogger = createContextLogger({ operation: 'stats', store: 'qdrant' });

    try {
      // Get collection info from Qdrant
      const collectionInfo = await this.client!.getCollection(this.collectionName);

      const vectorCount = collectionInfo.points_count || 0;
      
      // Qdrant provides segment info, we can estimate size
      const segments = collectionInfo.segments_count || 0;
      const dbSize = 'N/A'; // Qdrant doesn't expose exact size via API

      const result = {
        vectorCount,
        dbSize,
      };

      contextLogger.debug(result, 'Retrieved database statistics');
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to get database stats');
      errorRate.inc({ type: 'database', operation: 'stats' });
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Scroll through all points in the collection for efficient export
   * Uses cursor-based pagination to handle large datasets without loading all into memory
   * @param batchSize Number of points to retrieve per scroll request (default: 10000)
   * @yields Batches of Qdrant points with their vectors and payloads
   */
  async *scrollPoints(batchSize: number = 10000): AsyncGenerator<Array<{
    id: string | number;
    vector: number[];
    payload: Record<string, any>;
  }>, void, unknown> {
    this.ensureInitialized();

    const contextLogger = createContextLogger({ operation: 'scroll', store: 'qdrant', batchSize });
    contextLogger.info('Starting scroll operation');

    let offset: string | number | null = null;
    let totalYielded = 0;

    while (true) {
      const scrollParams: any = {
        limit: batchSize,
        with_payload: true,
        with_vector: true,
      };

      if (offset !== null) {
        scrollParams.offset = offset;
      }

      const response = await this.client!.scroll(this.collectionName, scrollParams);

      if (!response.points || response.points.length === 0) {
        contextLogger.info({ totalYielded }, 'Scroll operation completed');
        break;
      }

      // Transform points to a consistent format
      const points = response.points.map(point => ({
        id: point.id,
        vector: point.vector as number[],
        payload: point.payload as Record<string, any>,
      }));

      totalYielded += points.length;
      contextLogger.debug({ batchSize: points.length, totalYielded }, 'Yielding batch of points');

      yield points;

      // Get next page offset (can be string, number, or undefined)
      const nextOffset = response.next_page_offset;
      if (nextOffset === undefined || nextOffset === null) {
        contextLogger.info({ totalYielded }, 'Scroll operation completed');
        break;
      }
      // Cast to expected type - Qdrant typically returns string or number for scroll offset
      offset = nextOffset as string | number;
    }
  }

  /**
   * Get total points count in the collection
   * @returns Points count
   */
  async getPointsCount(): Promise<number> {
    this.ensureInitialized();
    const collectionInfo = await this.client!.getCollection(this.collectionName);
    return collectionInfo.points_count || 0;
  }

  /**
   * Fast scroll to collect only point IDs (no vectors, minimal payload)
   * Used as first pass for parallel export - ID collection is very fast
   * @param batchSize Number of points per scroll request
   * @param onProgress Optional callback for progress updates
   * @yields Arrays of point IDs with their key payload
   */
  async *scrollPointIds(
    batchSize: number = 10000,
    onProgress?: (count: number) => void
  ): AsyncGenerator<Array<{ id: string | number; key: string }>, void, unknown> {
    this.ensureInitialized();

    const contextLogger = createContextLogger({
      operation: 'scrollPointIds',
      store: 'qdrant',
      batchSize
    });
    contextLogger.info('Starting fast ID-only scroll');

    let offset: string | number | null = null;
    let totalYielded = 0;

    while (true) {
      const scrollParams: any = {
        limit: batchSize,
        with_payload: { include: ['key'] }, // Only get the key field
        with_vector: false, // No vectors - this is the key optimization
      };

      if (offset !== null) {
        scrollParams.offset = offset;
      }

      const response = await this.client!.scroll(this.collectionName, scrollParams);

      if (!response.points || response.points.length === 0) {
        contextLogger.info({ totalYielded }, 'ID scroll completed');
        break;
      }

      const points = response.points.map(point => ({
        id: point.id,
        key: (point.payload as any)?.key as string || String(point.id),
      }));

      totalYielded += points.length;

      if (onProgress) {
        onProgress(totalYielded);
      }

      yield points;

      const nextOffset = response.next_page_offset;
      if (nextOffset === undefined || nextOffset === null) {
        contextLogger.info({ totalYielded }, 'ID scroll completed');
        break;
      }
      offset = nextOffset as string | number;
    }
  }

  /**
   * Retrieve full point data for a list of point IDs
   * Used as second pass for parallel export - can be called in parallel for different ID sets
   * @param ids Array of point IDs to retrieve
   * @returns Array of points with full data (id, vector, payload)
   */
  async retrievePoints(
    ids: Array<string | number>
  ): Promise<Array<{ id: string | number; vector: number[]; payload: Record<string, any> }>> {
    this.ensureInitialized();

    if (ids.length === 0) {
      return [];
    }

    const contextLogger = createContextLogger({
      operation: 'retrievePoints',
      store: 'qdrant',
      count: ids.length
    });
    contextLogger.debug('Retrieving points by IDs');

    // Convert string IDs to BigInt for Qdrant (same as other methods)
    // This preserves precision for large tweet IDs (19+ digits)
    const bigIntIds = ids.map(id =>
      typeof id === 'string' ? BigInt(id) as any : id
    );

    const response = await this.client!.retrieve(this.collectionName, {
      ids: bigIntIds,
      with_payload: true,
      with_vector: true,
    });

    return response.map(point => ({
      id: typeof point.id === 'bigint' ? point.id.toString() : String(point.id),
      vector: point.vector as number[],
      payload: this.sanitizeMetadata(point.payload as Record<string, any>),
    }));
  }

  /**
   * Get the minimum and maximum point IDs in the collection
   * Used for partitioning parallel scroll operations
   * @returns Object with minId and maxId (as BigInts for precision)
   */
  async getIdBounds(): Promise<{ minId: bigint; maxId: bigint } | null> {
    this.ensureInitialized();
    const contextLogger = createContextLogger({ operation: 'getIdBounds', store: 'qdrant' });

    try {
      // Get min ID by scrolling with ascending order (default)
      const minResponse = await this.client!.scroll(this.collectionName, {
        limit: 1,
        with_payload: false,
        with_vector: false,
        order_by: { key: '', direction: 'asc' }, // Order by internal ID
      });

      // Get max ID by scrolling with descending order
      const maxResponse = await this.client!.scroll(this.collectionName, {
        limit: 1,
        with_payload: false,
        with_vector: false,
        order_by: { key: '', direction: 'desc' },
      });

      if (!minResponse.points?.length || !maxResponse.points?.length) {
        contextLogger.warn('No points found in collection');
        return null;
      }

      const minId = BigInt(minResponse.points[0].id);
      const maxId = BigInt(maxResponse.points[0].id);

      contextLogger.info({ minId: minId.toString(), maxId: maxId.toString() }, 'Retrieved ID bounds');
      return { minId, maxId };
    } catch (error) {
      // Fallback: if order_by doesn't work, try sampling approach
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.warn({ error: errorMessage }, 'order_by failed, using sampling fallback');

      // Sample some IDs to estimate bounds
      const sampleResponse = await this.client!.scroll(this.collectionName, {
        limit: 1000,
        with_payload: false,
        with_vector: false,
      });

      if (!sampleResponse.points?.length) {
        return null;
      }

      const ids = sampleResponse.points.map(p => BigInt(p.id));
      const minId = ids.reduce((a, b) => a < b ? a : b);
      const maxId = ids.reduce((a, b) => a > b ? a : b);

      contextLogger.info({ minId: minId.toString(), maxId: maxId.toString(), sampleSize: ids.length }, 'Estimated ID bounds from sample');
      return { minId, maxId };
    }
  }

  /**
   * Scroll through points within a specific ID range
   * Used for parallel export by partitioning the ID space
   * @param minId Minimum point ID (inclusive)
   * @param maxId Maximum point ID (inclusive)
   * @param batchSize Number of points per scroll request
   * @yields Batches of points within the ID range
   */
  async *scrollPointsInRange(
    minId: bigint,
    maxId: bigint,
    batchSize: number = 10000
  ): AsyncGenerator<Array<{
    id: string | number;
    vector: number[];
    payload: Record<string, any>;
  }>, void, unknown> {
    this.ensureInitialized();

    const contextLogger = createContextLogger({
      operation: 'scrollRange',
      store: 'qdrant',
      minId: minId.toString(),
      maxId: maxId.toString(),
      batchSize
    });
    contextLogger.info('Starting range scroll operation');

    let offset: string | number | null = null;
    let totalYielded = 0;

    // Build filter for ID range.
    // The casts to `number` are compile-time only - values remain bigint at runtime.
    // Qdrant client serializes bigint correctly via JSON.rawJSON (requires Bun 1.2+).
    const rangeFilter = {
      must: [
        {
          key: 'id', // Special Qdrant filter for point ID
          range: {
            gte: BigInt(minId) as unknown as number,
            lte: BigInt(maxId) as unknown as number,
          },
        },
      ],
    };

    while (true) {
      const scrollParams: any = {
        limit: batchSize,
        with_payload: true,
        with_vector: true,
        filter: rangeFilter,
      };

      if (offset !== null) {
        scrollParams.offset = offset;
      }

      const response = await this.client!.scroll(this.collectionName, scrollParams);

      if (!response.points || response.points.length === 0) {
        contextLogger.info({ totalYielded }, 'Range scroll completed');
        break;
      }

      // Transform points to a consistent format
      const points = response.points.map(point => ({
        id: point.id,
        vector: point.vector as number[],
        payload: point.payload as Record<string, any>,
      }));

      totalYielded += points.length;
      contextLogger.debug({ batchSize: points.length, totalYielded }, 'Yielding batch from range');

      yield points;

      const nextOffset = response.next_page_offset;
      if (nextOffset === undefined || nextOffset === null) {
        contextLogger.info({ totalYielded }, 'Range scroll completed');
        break;
      }
      offset = nextOffset as string | number;
    }
  }

  /**
   * Get collection cluster info including shard count
   * @returns Cluster info with shard details
   */
  async getClusterInfo(): Promise<{ shardCount: number; localShards: number[] }> {
    this.ensureInitialized();

    try {
      const clusterInfo = await this.client!.getCollectionClusterInfo(this.collectionName);
      const localShards = clusterInfo.local_shards?.map(s => s.shard_id) || [];
      const shardCount = clusterInfo.shard_count || localShards.length || 1;

      return { shardCount, localShards };
    } catch (error) {
      // If cluster info not available (single node), return defaults
      return { shardCount: 1, localShards: [0] };
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      const contextLogger = createContextLogger({ operation: 'close', store: 'qdrant' });
      contextLogger.info('Closing Qdrant client');

      // Qdrant client doesn't require explicit close
      this.client = null;
      this.isInitialized = false;
    }
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.client) {
      throw new Error('QdrantVectorStore not initialized. Call initialize() first.');
    }
  }
}

