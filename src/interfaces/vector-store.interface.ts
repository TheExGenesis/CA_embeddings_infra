import type { EmbeddingVector, SearchResult, SearchQuery } from '../types/index.js';

/**
 * Interface for vector store implementations
 * All vector store backends (Qdrant, etc.) must implement this interface
 */
export interface IVectorStore {
  /**
   * Initialize the vector store (open database, create collections, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Insert embeddings into the vector store
   * @param embeddings - Array of embeddings to insert
   */
  insert(embeddings: EmbeddingVector[]): Promise<void>;

  /**
   * Search for similar vectors
   * @param query - Search query with vector, k, optional filters
   * @returns Array of search results with keys and distances
   */
  search(query: SearchQuery): Promise<SearchResult[]>;

  /**
   * Delete vectors by their keys
   * @param keys - Array of keys to delete
   */
  delete(keys: string[]): Promise<void>;

  /** Return the subset of keys already present, for idempotent ingestion. */
  existingKeys?(keys: string[]): Promise<string[]>;

  /**
   * Get database statistics
   * @returns Statistics about vector count and database size
   */
  getStats(): Promise<{ vectorCount: number; dbSize: string }>;

  /**
   * Close the database connection and clean up resources
   */
  close(): Promise<void>;
}
