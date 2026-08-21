import { z } from 'zod';

export const EmbeddingVectorSchema = z.object({
  key: z.string().min(1).max(255),
  vector: z.array(z.number()).min(1),
  metadata: z.record(z.any()).optional(),
});

// ============================================================================
// Filter Schemas for Advanced Search (Qdrant-style)
// ============================================================================

/**
 * Match condition schema - for exact value or text matching
 */
export const MatchConditionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  text: z.string().optional(),
}).refine(
  (data) => data.value !== undefined || data.text !== undefined,
  { message: "Match condition must have either 'value' or 'text'" }
).refine(
  (data) => !(data.value !== undefined && data.text !== undefined),
  { message: "Match condition cannot have both 'value' and 'text'" }
);

/**
 * Range condition schema - for numeric and datetime filtering
 * Accepts numbers or ISO 8601 datetime strings or Unix timestamps
 */
export const RangeConditionSchema = z.object({
  gt: z.union([z.number(), z.string()]).optional(),
  gte: z.union([z.number(), z.string()]).optional(),
  lt: z.union([z.number(), z.string()]).optional(),
  lte: z.union([z.number(), z.string()]).optional(),
}).refine(
  (data) => data.gt !== undefined || data.gte !== undefined || data.lt !== undefined || data.lte !== undefined,
  { message: "Range condition must have at least one of: gt, gte, lt, lte" }
);

/**
 * Field condition schema - targets a specific metadata field
 */
export const FieldConditionSchema = z.object({
  key: z.string().min(1),
  match: MatchConditionSchema.optional(),
  range: RangeConditionSchema.optional(),
}).refine(
  (data) => data.match !== undefined || data.range !== undefined,
  { message: "Field condition must have either 'match' or 'range'" }
).refine(
  (data) => !(data.match !== undefined && data.range !== undefined),
  { message: "Field condition cannot have both 'match' and 'range'" }
);

/**
 * Base filter schema - defines the recursive structure
 * Uses z.lazy() to support recursive nesting of clauses
 */
export const FilterSchema: z.ZodType<{
  must?: Array<any>;
  should?: Array<any>;
  must_not?: Array<any>;
}> = z.lazy(() =>
  z.object({
    must: z.array(FilterItemSchema).optional(),
    should: z.array(FilterItemSchema).optional(),
    must_not: z.array(FilterItemSchema).optional(),
  }).refine(
    (data) => data.must !== undefined || data.should !== undefined || data.must_not !== undefined,
    { message: "Filter must have at least one of: must, should, must_not" }
  )
);

/**
 * Filter item schema - can be a field condition or nested filter
 */
export const FilterItemSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    FieldConditionSchema,
    FilterSchema,
  ])
);

// ============================================================================
// Legacy Filter Schema (Backward Compatibility)
// ============================================================================

/**
 * Legacy flat filter format for backward compatibility
 * Accepts any key-value pairs where values can be strings, numbers, or booleans
 * Examples: { "tokens": ">50", "provider": "deepinfra", "is_truncated": false }
 */
export const LegacyFilterSchema = z.record(
  z.union([z.string(), z.number(), z.boolean()])
);

/**
 * Helper to detect if a filter object is using the new clause-based format
 */
export function isClauseBasedFilter(filter: any): boolean {
  if (!filter || typeof filter !== 'object') return false;
  const keys = Object.keys(filter);
  // New format has must, should, or must_not at top level
  return keys.some(key => ['must', 'should', 'must_not'].includes(key));
}

/**
 * Combined filter schema - accepts both new clause-based and legacy flat formats
 */
export const SearchFilterSchema = z.union([
  FilterSchema,
  LegacyFilterSchema,
]);

// ============================================================================
// Search Query Schema
// ============================================================================

export const SearchQuerySchema = z.object({
  vector: z.array(z.number()).min(1).optional(),
  searchTerm: z.string().min(1).optional(),
  k: z.number().int().min(1).max(1000).default(10),
  threshold: z.number().min(0).max(1).optional(),
  filter: SearchFilterSchema.optional(),
  with_vector: z.boolean().optional().default(false),
  with_payload: z.boolean().optional().default(true),
}).refine(
  (data) => data.vector || data.searchTerm,
  {
    message: "Either 'vector' or 'searchTerm' must be provided",
    path: ["vector", "searchTerm"],
  }
).refine(
  (data) => !(data.vector && data.searchTerm),
  {
    message: "Cannot provide both 'vector' and 'searchTerm' at the same time",
    path: ["vector", "searchTerm"],
  }
);

export const BulkInsertSchema = z.object({
  embeddings: z.array(EmbeddingVectorSchema).min(1).max(10000),
});

export const BulkDeleteSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(10000),
});

export const EmbeddingGenerationItemSchema = z.object({
  key: z.string().min(1).max(255),
  content: z.string().min(1),
  contentType: z.literal('text'),
  metadata: z.record(z.any()).optional(),
});

export const GenerateEmbeddingsSchema = z.object({
  items: z.array(EmbeddingGenerationItemSchema).min(1).max(1000),
  return_vectors: z.boolean().optional().default(true),
});

// ============================================================================
// Metadata Update Schema
// ============================================================================

/**
 * Schema for a single metadata update item
 */
export const MetadataUpdateItemSchema = z.object({
  key: z.string().min(1).max(255),
  metadata: z.record(z.any()),
});

/**
 * Schema for bulk metadata update request
 */
export const UpdateMetadataSchema = z.object({
  items: z.array(MetadataUpdateItemSchema).min(1).max(10000),
});

// ============================================================================
// Retrieve Vector Schema
// ============================================================================

/**
 * Schema for retrieving embeddings by IDs
 */
export const RetrieveVectorSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
  with_vector: z.boolean().optional().default(true),
  with_payload: z.boolean().optional().default(true),
});

export const ExistingKeysSchema = z.object({
  ids: z.array(z.string().regex(/^\d+$/)).min(1).max(1000),
});

export const validateVector = (vector: number[], expectedDimension: number): void => {
  if (vector.length !== expectedDimension) {
    throw new Error(`Vector dimension mismatch. Expected ${expectedDimension}, got ${vector.length}`);
  }

  if (vector.some(val => !Number.isFinite(val))) {
    throw new Error('Vector contains invalid values (NaN or Infinity)');
  }
};

export const normalizeVector = (vector: number[]): Float32Array => {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));

  if (magnitude === 0) {
    throw new Error('Cannot normalize zero vector');
  }

  return new Float32Array(vector.map(val => val / magnitude));
};

export type EmbeddingVectorInput = z.infer<typeof EmbeddingVectorSchema>;
export type SearchQueryInput = z.infer<typeof SearchQuerySchema>;
export type BulkInsertInput = z.infer<typeof BulkInsertSchema>;
export type BulkDeleteInput = z.infer<typeof BulkDeleteSchema>;
export type EmbeddingGenerationItemInput = z.infer<typeof EmbeddingGenerationItemSchema>;
export type GenerateEmbeddingsInput = z.infer<typeof GenerateEmbeddingsSchema>;
export type MetadataUpdateItemInput = z.infer<typeof MetadataUpdateItemSchema>;
export type UpdateMetadataInput = z.infer<typeof UpdateMetadataSchema>;
export type RetrieveVectorInput = z.infer<typeof RetrieveVectorSchema>;
export type ExistingKeysInput = z.infer<typeof ExistingKeysSchema>;
