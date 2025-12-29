import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { IVectorStore } from '../interfaces/vector-store.interface.js';
import {
  BulkInsertSchema,
  BulkDeleteSchema,
  SearchQuerySchema,
  UpdateMetadataSchema,
  RetrieveVectorSchema,
  validateVector,
  normalizeVector,
  type BulkInsertInput,
  type BulkDeleteInput,
  type SearchQueryInput,
  type UpdateMetadataInput,
  type RetrieveVectorInput
} from '../utils/validation.js';
import { createContextLogger } from '../observability/logger.js';
import { appConfig } from '../config/index.js';
import { apiKeyAuthMiddleware } from '../middleware/index.js';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

// Track active export process
let activeExportProcess: ChildProcess | null = null;
let exportStartTime: number | null = null;
let exportLogs: string[] = [];

interface EmbeddingRoutes {
  embeddingService: IVectorStore;
}

const embeddingRoutes: FastifyPluginAsync<EmbeddingRoutes> = async (fastify, { embeddingService }) => {

  fastify.post<{
    Body: BulkInsertInput;
  }>('/embeddings', {
    preHandler: apiKeyAuthMiddleware
  }, async (request: FastifyRequest<{ Body: BulkInsertInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'bulk_insert',
      count: request.body.embeddings.length
    });

    try {
      contextLogger.info('Processing bulk insert request');

      const embeddings = request.body.embeddings.map(emb => {
        validateVector(emb.vector, appConfig.database.dimension);

        return {
          key: emb.key,
          vector: new Float32Array(emb.vector),
          metadata: emb.metadata,
        };
      });

      await embeddingService.insert(embeddings);

      reply.status(201).send({
        success: true,
        message: 'Embeddings inserted successfully',
        inserted: embeddings.length,
      });

      contextLogger.info('Bulk insert completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Bulk insert failed');

      reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  fastify.post<{
    Body: SearchQueryInput;
  }>('/embeddings/search', async (request: FastifyRequest<{ Body: SearchQueryInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'search',
      k: request.body.k,
      hasVector: !!request.body.vector,
      hasSearchTerm: !!request.body.searchTerm
    });

    try {
      contextLogger.info('Processing search request');

      let queryVector: Float32Array;

      if (request.body.vector) {
        // Direct vector search
        validateVector(request.body.vector, appConfig.database.dimension);
        queryVector = new Float32Array(request.body.vector);
        contextLogger.info('Using provided vector for search');
      } else if (request.body.searchTerm) {
        // Text-based search - generate embedding first
        contextLogger.info('Generating embedding for search term');

        // Get embedding generation service from the context
        const embeddingGenerationService = (fastify as any).embeddingGenerationService;
        if (!embeddingGenerationService) {
          throw new Error('Embedding generation service not available. Please ensure it is enabled in the server configuration.');
        }

        // Generate embedding for the search term
        const generationResults = await embeddingGenerationService.generateEmbeddings([{
          key: `search_query_${Date.now()}`,
          content: request.body.searchTerm,
          contentType: 'text' as const,
          metadata: { type: 'search_query' }
        }]);

        if (generationResults.length === 0) {
          throw new Error('Failed to generate embedding for search term');
        }

        queryVector = new Float32Array(generationResults[0].vector);
        contextLogger.info('Embedding generated successfully for search term');
      } else {
        throw new Error('Either vector or searchTerm must be provided');
      }

      const results = await embeddingService.search({
        vector: queryVector,
        k: request.body.k || 10,
        threshold: request.body.threshold || 0.65,
        filter: request.body.filter,
        with_vector: request.body.with_vector ?? false,
        with_payload: request.body.with_payload ?? true,
      });

      reply.send({
        success: true,
        results,
        count: results.length,
      });

      contextLogger.info({ resultCount: results.length }, 'Search completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Search failed');

      reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  fastify.delete<{
    Body: BulkDeleteInput;
  }>('/embeddings', {
    preHandler: apiKeyAuthMiddleware
  }, async (request: FastifyRequest<{ Body: BulkDeleteInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'bulk_delete',
      count: request.body.keys.length
    });

    try {
      contextLogger.info('Processing bulk delete request');

      await embeddingService.delete(request.body.keys);

      reply.send({
        success: true,
        message: 'Embeddings deleted successfully',
        deleted: request.body.keys.length,
      });

      contextLogger.info('Bulk delete completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Bulk delete failed');

      reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  fastify.get<{
    Params: { key: string };
  }>('/embeddings/exists/:key', async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const { key } = request.params;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'exists',
      key
    });

    try {
      contextLogger.debug('Checking if embedding exists');

      // Check if the vector store has an exists method (Qdrant does)
      if ('exists' in embeddingService && typeof (embeddingService as any).exists === 'function') {
        const exists = await (embeddingService as any).exists(key);
        
        reply.send({
          success: true,
          exists,
          key,
        });

        contextLogger.debug({ exists }, 'Existence check completed');
      } else {
        throw new Error('Exists operation not supported by current vector store');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to check existence');

      reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  fastify.get('/embeddings/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'stats'
    });

    try {
      contextLogger.info('Getting database statistics');

      const stats = await embeddingService.getStats();

      reply.send({
        ...stats,
        dimension: appConfig.database.dimension,
      });

      contextLogger.info('Statistics retrieved successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to get statistics');

      reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * Update metadata for existing embeddings without modifying vectors
   * POST /embeddings/update-metadata
   */
  fastify.post<{
    Body: UpdateMetadataInput;
  }>('/embeddings/update-metadata', {
    preHandler: apiKeyAuthMiddleware
  }, async (request: FastifyRequest<{ Body: UpdateMetadataInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'update_metadata',
      count: request.body.items.length
    });

    try {
      contextLogger.info('Processing metadata update request');

      // Validate request body
      const parsed = UpdateMetadataSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: parsed.error.errors,
        });
      }

      // Check if the vector store has an updateMetadata method
      if (!('updateMetadata' in embeddingService) || typeof (embeddingService as any).updateMetadata !== 'function') {
        throw new Error('Metadata update operation not supported by current vector store');
      }

      // Convert items to the format expected by updateMetadata
      const updates = request.body.items.map(item => ({
        key: item.key,
        metadata: item.metadata,
      }));

      // Call the updateMetadata method
      const result = await (embeddingService as any).updateMetadata(updates);

      reply.send({
        success: true,
        message: 'Metadata update completed',
        updated: result.updated,
        failed: result.failed,
        total: request.body.items.length,
      });

      contextLogger.info({ updated: result.updated, failed: result.failed }, 'Metadata update completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Metadata update failed');

      reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * Retrieve embeddings by IDs
   * POST /embeddings/retrieve
   * - Open endpoint (no auth required by default)
   * - Rate limited to 10,000 requests/hour for unauthenticated users
   * - API key holders bypass rate limit
   */
  fastify.post<{
    Body: RetrieveVectorInput;
  }>('/embeddings/retrieve', {
    config: {
      rateLimit: {
        max: 10000,
        timeWindow: '1 hour',
        keyGenerator: (request: FastifyRequest) => {
          // If API key present and valid, use unique key per API key (effectively no shared limit)
          const apiKey = request.headers['x-api-key'] as string | undefined;
          if (apiKey && appConfig.security.apiKeys.includes(apiKey)) {
            return `apikey:${apiKey}`;  // Each API key gets own bucket
          }
          return request.ip;  // Anonymous users share IP-based limit
        },
        errorResponseBuilder: () => ({
          success: false,
          error: 'Rate limit exceeded (10,000 requests/hour). Use an API key to bypass this limit.',
          code: 'RATE_LIMIT_EXCEEDED'
        })
      }
    }
  }, async (request: FastifyRequest<{ Body: RetrieveVectorInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'retrieve',
      count: request.body?.ids?.length
    });

    try {
      contextLogger.info('Processing retrieve request');

      // Validate request body
      const parsed = RetrieveVectorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: parsed.error.errors,
        });
      }

      const { ids, with_vector, with_payload } = parsed.data;

      // Check if the vector store has retrievePoints method (Qdrant does)
      if (!('retrievePoints' in embeddingService) || typeof (embeddingService as any).retrievePoints !== 'function') {
        throw new Error('Retrieve operation not supported by current vector store');
      }

      // Retrieve points from the vector store
      const points = await (embeddingService as any).retrievePoints(ids);

      // Format response to match search endpoint shape
      // Note: retrievePoints already sanitizes BigInt values to strings
      const results = points.map((point: { id: string; vector: number[]; payload: Record<string, any> }) => {
        const result: Record<string, any> = {};

        // Use key from payload (like search does), fallback to id
        result.key = point.payload?.key || point.id;

        if (with_vector && point.vector) {
          result.vector = Array.from(point.vector);
        }

        if (with_payload && point.payload?.metadata) {
          // Return only the metadata object, not internal fields like queueItemId, timestamp, correlationId
          result.metadata = point.payload.metadata;
        }

        return result;
      });

      reply.send({
        success: true,
        results,
        count: results.length,
      });

      contextLogger.info({ resultCount: results.length }, 'Retrieve completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Retrieve failed');

      reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * Export vector store to cloud storage using Go exporter
   * POST /embeddings/export
   * Protected endpoint - requires API key
   *
   * @param destination - 'r2' or 'supabase' (required)
   * @param strategy - Export strategy (only for r2): 'ndjson-gz' | 'parquet-small' | 'parquet-med' | 'parquet-large'
   *
   * Spawns the Go binary for efficient parallel export.
   * Only one export can run at a time.
   */
  fastify.post<{
    Body: {
      destination: 'r2' | 'supabase';
      strategy?: 'ndjson-gz' | 'parquet-small' | 'parquet-med' | 'parquet-large';
    };
  }>('/embeddings/export', {
    preHandler: apiKeyAuthMiddleware
  }, async (request: FastifyRequest<{ Body: { destination: 'r2' | 'supabase'; strategy?: string } }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const destination = request.body?.destination;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'export',
      destination,
      strategy: request.body?.strategy,
    });

    try {
      // Validate destination parameter
      if (!destination || !['r2', 'supabase'].includes(destination)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid or missing destination parameter. Must be "r2" or "supabase".',
        });
      }

      contextLogger.info(`Processing ${destination} export request`);

      // Validate configuration based on destination
      if (destination === 'r2') {
        if (!appConfig.r2?.enabled) {
          return reply.status(400).send({
            success: false,
            error: 'R2 export is not configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, and R2_BUCKET environment variables.',
          });
        }
      } else if (destination === 'supabase') {
        if (!appConfig.supabase?.url) {
          return reply.status(400).send({
            success: false,
            error: 'Supabase export is not configured. Set SUPABASE_URL environment variable.',
          });
        }
        if (!appConfig.supabase?.serviceRoleKey) {
          return reply.status(400).send({
            success: false,
            error: 'Supabase service role key is not configured. Set SUPABASE_SERVICE_ROLE_KEY environment variable.',
          });
        }
        if (!appConfig.supabase?.storageBucket) {
          return reply.status(400).send({
            success: false,
            error: 'Supabase storage bucket is not configured. Set SUPABASE_STORAGE_BUCKET environment variable.',
          });
        }
      }

      // Check if an export is already in progress
      if (activeExportProcess && !activeExportProcess.killed) {
        const runningFor = exportStartTime ? Math.round((Date.now() - exportStartTime) / 1000) : 0;
        return reply.status(409).send({
          success: false,
          error: 'Export already in progress',
          message: `An export process is already running (${runningFor}s elapsed). Please wait for it to complete.`,
          runningForSeconds: runningFor,
          recentLogs: exportLogs.slice(-20),
        });
      }

      // Calculate parallel workers (half of available CPUs)
      const cpuCount = (await import('node:os')).cpus().length;
      const parallelWorkers = Math.max(1, Math.floor(cpuCount / 2));

      // Build command arguments and determine binary based on destination
      let binaryPath: string;
      let args: string[];

      if (destination === 'r2') {
        const strategy = request.body?.strategy || 'parquet-med';
        args = [
          '--http',
          '--strategy', strategy,
          '--parallel', String(parallelWorkers),
          '--stream-upload',
        ];
        binaryPath = path.join(process.cwd(), 'scripts', 'go', 'qdrant_exporter_r2');
      } else {
        // supabase
        args = [
          '--parallel', String(parallelWorkers),
        ];
        binaryPath = path.join(process.cwd(), 'scripts', 'go', 'qdrant_exporter_supabase');
      }

      contextLogger.info({ binaryPath, args, destination }, 'Spawning Go exporter');

      // Reset state
      exportLogs = [];
      exportStartTime = Date.now();

      // Build environment variables
      const envVars: Record<string, string> = {
        ...process.env as Record<string, string>,
        // Pass Qdrant config
        QDRANT_URL: appConfig.database.qdrant?.url || 'http://localhost:6333',
        QDRANT_API_KEY: appConfig.database.qdrant?.apiKey || '',
        QDRANT_COLLECTION_NAME: appConfig.database.qdrant?.collectionName || 'embeddings',
        QDRANT_PORT: String(appConfig.database.qdrant?.port || ''),
        VECTOR_DIMENSION: String(appConfig.database.dimension || 1024),
      };

      // Add destination-specific env vars
      if (destination === 'supabase') {
        envVars.SUPABASE_URL = appConfig.supabase!.url;
        envVars.SUPABASE_SERVICE_ROLE_KEY = appConfig.supabase!.serviceRoleKey!;
        envVars.SUPABASE_STORAGE_BUCKET = appConfig.supabase!.storageBucket!;
      }

      // Spawn the Go exporter process
      activeExportProcess = spawn(binaryPath, args, {
        env: envVars,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const proc = activeExportProcess;

      // Capture stdout
      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          exportLogs.push(`[stdout] ${line}`);
          contextLogger.info({ output: line }, 'Go exporter stdout');
        }
        if (exportLogs.length > 1000) {
          exportLogs = exportLogs.slice(-1000);
        }
      });

      // Capture stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          exportLogs.push(`[stderr] ${line}`);
          contextLogger.warn({ output: line }, 'Go exporter stderr');
        }
      });

      // Handle process completion
      proc.on('close', (code) => {
        const duration = exportStartTime ? Date.now() - exportStartTime : 0;
        if (code === 0) {
          contextLogger.info({ code, durationMs: duration }, 'Go exporter completed successfully');
          exportLogs.push(`[system] Export completed successfully in ${Math.round(duration / 1000)}s`);
        } else {
          contextLogger.error({ code, durationMs: duration }, 'Go exporter failed');
          exportLogs.push(`[system] Export failed with code ${code} after ${Math.round(duration / 1000)}s`);
        }
        activeExportProcess = null;
        exportStartTime = null;
      });

      proc.on('error', (err) => {
        contextLogger.error({ error: err.message }, 'Go exporter spawn error');
        exportLogs.push(`[system] Spawn error: ${err.message}`);
        activeExportProcess = null;
        exportStartTime = null;
      });

      // Return immediately - export runs in background
      reply.status(202).send({
        success: true,
        message: `Export to ${destination} started`,
        destination,
        status: 'running',
        pid: proc.pid,
        args,
        checkStatusAt: '/embeddings/export/status',
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Export failed to start');

      reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * Get export status
   * GET /embeddings/export/status
   * Protected endpoint - requires API key
   */
  fastify.get('/embeddings/export/status', {
    preHandler: apiKeyAuthMiddleware
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const isRunning = activeExportProcess && !activeExportProcess.killed;
    const runningFor = exportStartTime ? Math.round((Date.now() - exportStartTime) / 1000) : 0;

    reply.send({
      success: true,
      status: isRunning ? 'running' : 'idle',
      runningForSeconds: isRunning ? runningFor : null,
      pid: isRunning ? activeExportProcess?.pid : null,
      recentLogs: exportLogs.slice(-50),
    });
  });

  /**
   * Cancel running export
   * DELETE /embeddings/export
   * Protected endpoint - requires API key
   */
  fastify.delete('/embeddings/export', {
    preHandler: apiKeyAuthMiddleware
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!activeExportProcess || activeExportProcess.killed) {
      return reply.status(404).send({
        success: false,
        error: 'No export process is running',
      });
    }

    const pid = activeExportProcess.pid;
    activeExportProcess.kill('SIGTERM');
    exportLogs.push('[system] Export cancelled by user');

    reply.send({
      success: true,
      message: 'Export cancelled',
      pid,
    });
  });

};

export default embeddingRoutes;