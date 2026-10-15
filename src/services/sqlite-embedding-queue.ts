import { Database } from 'bun:sqlite';
import type { EmbeddingVector } from '../types/index.js';
import { createContextLogger } from '../observability/logger.js';
import { queueProcessingRate, queueRetryCount } from '../observability/metrics.js';

interface QueueStats {
  pending: number;
  processing: number;
  failed: number;
}

export class SqliteEmbeddingQueue {
  private db: Database;
  private logger = createContextLogger({ service: 'sqlite-embedding-queue' });
  private isProcessing = false;
  private isShuttingDown = false;

  constructor(
    private dbPath: string,
    private embeddingService: any,
    private processIntervalMs: number = 1000,
    private insertChunkSize: number = 1000,
    private maxRetries: number = 3
  ) {
    // Initialize database with WAL mode for better concurrency
    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA cache_size = -64000'); // 64MB cache

    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Create tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS embedding_queue (
        key TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        metadata TEXT,
        correlation_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'failed')),
        retry_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_message TEXT
      )
    `);

    // Create indexes
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_queue_status_created
      ON embedding_queue(status, created_at)
    `);

    this.logger.info('SQLite schema initialized');
  }

  async initialize(): Promise<void> {
    // Recover any processing items from previous shutdown
    await this.recoverProcessingItems();

    // Start background processor
    this.startProcessor();

    this.logger.info({
      dbPath: this.dbPath,
      insertChunkSize: this.insertChunkSize
    }, 'SQLite embedding queue initialized');
  }

  private async recoverProcessingItems(): Promise<void> {
    const result = this.db.run(`
      UPDATE embedding_queue
      SET status = 'pending', updated_at = datetime('now')
      WHERE status = 'processing'
    `);

    if (result.changes > 0) {
      this.logger.info({ recoveredItems: result.changes }, 'Recovered processing items from previous shutdown');
    }
  }

  async enqueue(embeddings: EmbeddingVector[], correlationId?: string): Promise<void> {
    if (embeddings.length === 0) {
      this.logger.warn('No embeddings to enqueue');
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_queue
        (key, vector, metadata, correlation_id, status, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
    `);

    const transaction = this.db.transaction((embeddings: EmbeddingVector[]) => {
      for (const emb of embeddings) {
        // Compress vector using Bun native gzip
        const uint8View = new Uint8Array(emb.vector.buffer);
        // @ts-expect-error - Bun's gzipSync returns Uint8Array<ArrayBufferLike> but Buffer.from can handle it
        const compressed: Uint8Array = Bun.gzipSync(uint8View);
        // Convert to Buffer for SQLite compatibility
        const compressedBuffer = Buffer.from(compressed);

        stmt.run(
          emb.key,
          compressedBuffer,
          JSON.stringify(emb.metadata || {}),
          correlationId || null
        );
      }
    });

    transaction(embeddings);

    this.logger.debug({
      embeddingCount: embeddings.length,
      correlationId
    }, 'Embeddings enqueued');
  }

  private startProcessor(): void {
    // Start continuous processing loop
    this.runProcessorLoop();
  }

  private async runProcessorLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      if (this.isProcessing) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      this.isProcessing = true;

      try {
        const result = await this.processPendingBatch();

        if (result.processed > 0) {
          this.logger.debug({
            processed: result.processed,
            failed: result.failed
          }, 'Processed batch');
          // Continue immediately to next batch if we processed something
          this.isProcessing = false;
          continue;
        }
      } catch (error) {
        this.logger.error({ error }, 'Error processing queue');
      }

      this.isProcessing = false;

      // Only wait if queue was empty - check again after interval
      await new Promise(resolve => setTimeout(resolve, this.processIntervalMs));
    }
  }

  private async processPendingBatch(): Promise<{ processed: number; failed: number }> {
    const batchSize = this.insertChunkSize;

    // Get pending batch
    const rows = this.db.query(`
      SELECT key, vector, metadata, correlation_id, retry_count
      FROM embedding_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(batchSize) as Array<{
      key: string;
      vector: Uint8Array;
      metadata: string;
      correlation_id: string | null;
      retry_count: number;
    }>;

    if (rows.length === 0) {
      return { processed: 0, failed: 0 };
    }

    // Skip marking as 'processing' - just delete on success
    // Recovery mechanism handles crashes by resetting any 'processing' items on startup

    // Decompress all vectors and prepare embeddings
    const embeddings: EmbeddingVector[] = [];
    const rowsByKey = new Map<string, typeof rows[0]>();

    for (const row of rows) {
      try {
        const compressedBuffer = Buffer.from(row.vector);
        const decompressed = Bun.gunzipSync(compressedBuffer);
        const vector = new Float32Array(
          decompressed.buffer,
          decompressed.byteOffset,
          decompressed.byteLength / 4
        );

        embeddings.push({
          key: row.key,
          vector,
          metadata: JSON.parse(row.metadata)
        });
        rowsByKey.set(row.key, row);
      } catch (error) {
        // Decompression failed - mark as failed immediately
        const errorMessage = error instanceof Error ? error.message : 'Decompression failed';
        this.db.run(`
          UPDATE embedding_queue
          SET status = 'failed', error_message = ?, updated_at = datetime('now')
          WHERE key = ?
        `, [errorMessage, row.key]);
        this.logger.error({ key: row.key, error: errorMessage }, 'Failed to decompress vector');
      }
    }

    if (embeddings.length === 0) {
      return { processed: 0, failed: rows.length };
    }

    let processed = 0;
    let failed = 0;

    try {
      // Batch insert to vector store - single HTTP call for all embeddings
      await this.embeddingService.insert(embeddings);

      // All succeeded - delete from queue in a single transaction
      const successKeys = embeddings.map(e => e.key);
      this.db.run(`
        DELETE FROM embedding_queue
        WHERE key IN (${successKeys.map(() => '?').join(',')})
      `, successKeys);

      processed = embeddings.length;

      // Record metrics
      queueProcessingRate.inc({ status: 'success' }, processed);

      this.logger.info({ count: processed }, 'Successfully processed batch of embeddings');

    } catch (error) {
      // Batch insert failed - need to handle retry logic
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn({ error: errorMessage, count: embeddings.length }, 'Batch insert failed, will retry items');

      // Record failure metrics
      queueProcessingRate.inc({ status: 'failure' }, embeddings.length);

      // Update all items for retry or mark as failed
      const updateRetryStmt = this.db.prepare(`
        UPDATE embedding_queue
        SET status = 'pending', retry_count = ?, updated_at = datetime('now'), error_message = ?
        WHERE key = ?
      `);

      const markFailedStmt = this.db.prepare(`
        UPDATE embedding_queue
        SET status = 'failed', error_message = ?, updated_at = datetime('now')
        WHERE key = ?
      `);

      const transaction = this.db.transaction(() => {
        for (const emb of embeddings) {
          const row = rowsByKey.get(emb.key);
          if (!row) continue;

          const retryCount = row.retry_count + 1;

          if (retryCount <= this.maxRetries) {
            updateRetryStmt.run(retryCount, errorMessage, emb.key);
            queueRetryCount.inc();
          } else {
            markFailedStmt.run(errorMessage, emb.key);
            failed++;
          }
        }
      });
      transaction();
    }

    return { processed, failed };
  }

  getStats(): QueueStats {
    const pending = this.db.query(`SELECT COUNT(*) as count FROM embedding_queue WHERE status = 'pending'`).get() as { count: number };
    const processing = this.db.query(`SELECT COUNT(*) as count FROM embedding_queue WHERE status = 'processing'`).get() as { count: number };
    const failed = this.db.query(`SELECT COUNT(*) as count FROM embedding_queue WHERE status = 'failed'`).get() as { count: number };

    return {
      pending: pending.count,
      processing: processing.count,
      failed: failed.count
    };
  }

  async retryFailed(): Promise<number> {
    const result = this.db.run(`
      UPDATE embedding_queue
      SET status = 'pending', retry_count = 0, updated_at = datetime('now'), error_message = NULL
      WHERE status = 'failed'
    `);

    this.logger.info({ retriedCount: result.changes }, 'Retried failed embeddings');
    return result.changes;
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down SQLite embedding queue...');

    // Signal shutdown - this will stop the processor loop
    this.isShuttingDown = true;

    // Wait for current processing to complete
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const stats = this.getStats();

    this.logger.info({
      pending: stats.pending,
      processing: stats.processing,
      failed: stats.failed
    }, 'SQLite queue shutdown complete');
  }

  close(): void {
    this.db.close();
  }
}
