import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { EmbeddingGenerationService } from '../services/embedding-generation-service.js';
import { EmbeddingWriteQueueManager } from '../services/EmbeddingWriteQueueManager.js';
import {
  GenerateEmbeddingsSchema,
  type GenerateEmbeddingsInput
} from '../utils/validation.js';
import { createContextLogger } from '../observability/logger.js';
import { appConfig } from '../config/index.js';
import { apiKeyAuthMiddleware } from '../middleware/index.js';
import type {
  GenerateEmbeddingsResponse,
  EmbeddingGenerationItem
} from '../types/index.js';

interface EmbeddingGenerationRoutes {
  embeddingGenerationService: EmbeddingGenerationService;
  embeddingWriteQueue?: EmbeddingWriteQueueManager; // Optional for backward compatibility
}

const embeddingGenerationRoutes: FastifyPluginAsync<EmbeddingGenerationRoutes> = async (fastify, { embeddingGenerationService, embeddingWriteQueue }) => {

  fastify.post<{
    Body: GenerateEmbeddingsInput;
  }>('/embeddings/generate', {
    preHandler: apiKeyAuthMiddleware
  }, async (request: FastifyRequest<{ Body: GenerateEmbeddingsInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'generate_embeddings',
      count: request.body.items.length
    });

    try {
      contextLogger.info('Processing embedding generation request');

      // Validate request body
      const validatedData = GenerateEmbeddingsSchema.parse(request.body);

      // Transform to internal format
      const items: EmbeddingGenerationItem[] = validatedData.items.map(item => ({
        key: item.key,
        content: item.content,
        contentType: 'text' as const,
        metadata: item.metadata,
      }));

      // Generate embeddings
      const results = await embeddingGenerationService.generateEmbeddings(items);

      const response: GenerateEmbeddingsResponse = {
        success: true,
        results: results.map(result => ({
          key: result.key,
          vector: Array.from(result.vector),
          metadata: result.metadata,
        })),
        generated: results.length,
      };

      reply.status(201).send(response);

      contextLogger.info({
        generated: results.length
      }, 'Embedding generation completed successfully');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Embedding generation failed');

      const response: GenerateEmbeddingsResponse = {
        success: false,
        error: errorMessage,
        generated: 0,
      };

      reply.status(400).send(response);
    }
  });

  fastify.post<{
    Body: GenerateEmbeddingsInput;
  }>('/embeddings/generate-and-store', {
    preHandler: apiKeyAuthMiddleware
  }, async (request: FastifyRequest<{ Body: GenerateEmbeddingsInput }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'generate_and_store_embeddings',
      count: request.body.items.length
    });

    try {
      contextLogger.info('Processing embedding generation and storage request');

      // Validate request body
      const validatedData = GenerateEmbeddingsSchema.parse(request.body);

      // Transform to internal format
      const items: EmbeddingGenerationItem[] = validatedData.items.map(item => ({
        key: item.key,
        content: item.content,
        contentType: 'text' as const,
        metadata: item.metadata,
      }));

      // Generate embeddings
      const results = await embeddingGenerationService.generateEmbeddings(items);

      // Transform embeddings for storage
      const embeddings = results.map(result => ({
        key: result.key,
        vector: new Float32Array(result.vector),
        metadata: result.metadata,
      }));
      
      // Use write queue if available, otherwise fall back to direct insert
      if (embeddingWriteQueue) {
        // Queue embeddings for asynchronous storage (non-blocking)
        await embeddingWriteQueue.queueEmbeddings(embeddings, correlationId);
        
        contextLogger.info({
          generated: results.length,
          queued: embeddings.length
        }, 'Embedding generation completed and queued for storage');
      } else {
        // Fallback to direct insert for backward compatibility
        const embeddingService = (fastify as any).embeddingService;
        if (!embeddingService) {
          throw new Error('Neither embedding write queue nor embedding service available');
        }
        
        await embeddingService.insert(embeddings);
        
        contextLogger.info({
          generated: results.length,
          stored: embeddings.length
        }, 'Embedding generation and storage completed successfully (direct insert)');
      }

      const response: GenerateEmbeddingsResponse = {
        success: true,
        results: validatedData.return_vectors ? results.map(result => ({
          key: result.key,
          vector: result.vector,
          metadata: result.metadata,
        })) : undefined,
        generated: results.length,
      };

      reply.status(201).send(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Embedding generation and storage failed');

      const response: GenerateEmbeddingsResponse = {
        success: false,
        error: errorMessage,
        generated: 0,
      };

      reply.status(400).send(response);
    }
  });

  fastify.get('/embeddings/generation/history', async (request: FastifyRequest<{
    Querystring: { limit?: string }
  }>, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'get_generation_history'
    });

    try {
      const limit = parseInt((request.query as any)?.limit || '100', 10);
      if (isNaN(limit) || limit <= 0 || limit > 1000) {
        throw new Error('Limit must be a positive number between 1 and 1000');
      }

      const history = await embeddingGenerationService.getCallHistory(limit);

      reply.send({
        success: true,
        history,
        count: history.length,
      });

      contextLogger.info({
        returned: history.length
      }, 'Generation history retrieved successfully');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to get generation history');

      reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  fastify.get('/embeddings/generation/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = (request as any).correlationId;
    const contextLogger = createContextLogger({
      correlationId,
      operation: 'get_generation_stats'
    });

    try {
      const stats = await embeddingGenerationService.getCallStats();

      reply.send({
        success: true,
        ...stats,
      });

      contextLogger.info('Generation stats retrieved successfully');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      contextLogger.error({ error: errorMessage }, 'Failed to get generation stats');

      reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  // Queue management endpoints (only available if write queue is enabled)
  if (embeddingWriteQueue) {
    // Get queue statistics
    fastify.get('/embeddings/queue/stats', async (request: FastifyRequest, reply: FastifyReply) => {
      const correlationId = (request as any).correlationId;
      const contextLogger = createContextLogger({
        correlationId,
        operation: 'get_queue_stats'
      });

      try {
        const stats = await embeddingWriteQueue.getStats();

        reply.send({
          success: true,
          ...stats,
        });

        contextLogger.info('Queue stats retrieved successfully');

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        contextLogger.error({ error: errorMessage }, 'Failed to get queue stats');

        reply.status(500).send({
          success: false,
          error: errorMessage,
        });
      }
    });

    // Get queue health status
    fastify.get('/embeddings/queue/health', async (request: FastifyRequest, reply: FastifyReply) => {
      const correlationId = (request as any).correlationId;
      const contextLogger = createContextLogger({
        correlationId,
        operation: 'get_queue_health'
      });

      try {
        const health = await embeddingWriteQueue.isHealthy();

        reply.send({
          success: true,
          ...health,
        });

        if (!health.healthy) {
          contextLogger.warn({ issues: health.issues }, 'Queue health check found issues');
        } else {
          contextLogger.info('Queue health check passed');
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        contextLogger.error({ error: errorMessage }, 'Failed to get queue health');

        reply.status(500).send({
          success: false,
          error: errorMessage,
        });
      }
    });

    // Retry failed items
    fastify.post('/embeddings/queue/retry-failed', {
      preHandler: apiKeyAuthMiddleware
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      const correlationId = (request as any).correlationId;
      const contextLogger = createContextLogger({
        correlationId,
        operation: 'retry_failed_items'
      });

      try {
        await embeddingWriteQueue.retryFailedItems();

        reply.send({
          success: true,
          message: 'Failed items queued for retry',
        });

        contextLogger.info('Failed items retry initiated successfully');

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        contextLogger.error({ error: errorMessage }, 'Failed to retry failed items');

        reply.status(500).send({
          success: false,
          error: errorMessage,
        });
      }
    });

    // Get completed files information
    fastify.get('/embeddings/queue/completed', async (request: FastifyRequest, reply: FastifyReply) => {
      const correlationId = (request as any).correlationId;
      const contextLogger = createContextLogger({
        correlationId,
        operation: 'get_completed_files'
      });

      try {
        const completedFiles = await embeddingWriteQueue.getCompletedFilesInfo();

        reply.send({
          success: true,
          files: completedFiles,
          count: completedFiles.length,
        });

        contextLogger.info({ fileCount: completedFiles.length }, 'Completed files info retrieved successfully');

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        contextLogger.error({ error: errorMessage }, 'Failed to get completed files info');

        reply.status(500).send({
          success: false,
          error: errorMessage,
        });
      }
    });
  }
};

export default embeddingGenerationRoutes;
