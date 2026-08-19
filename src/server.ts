import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'path';

import { createVectorStore } from './factories/vector-store.factory.js';
import type { IVectorStore } from './interfaces/vector-store.interface.js';
import { EmbeddingGenerationService } from './services/embedding-generation-service.js';
import { EmbeddingWriteQueueManager } from './services/EmbeddingWriteQueueManager.js';
import { SupabaseListenerService } from './services/supabase-listener-service.js';
import { embeddingRoutes, healthRoutes, embeddingGenerationRoutes } from './api/index.js';
import { correlationMiddleware, metricsMiddleware, metricsResponseHook } from './middleware/index.js';
import { logger } from './observability/logger.js';
import { initializeTracing, shutdownTracing } from './observability/tracing.js';
import { initializeMetrics, closeMetrics } from './observability/metrics.js';
import { appConfig } from './config/index.js';

export async function createServer() {
  initializeTracing();

  // Initialize persistent metrics
  await initializeMetrics();

  const fastify = Fastify({
    logger: false,
    trustProxy: true,
  });

  if (appConfig.security.helmetEnabled) {
    await fastify.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
    });
  }

  await fastify.register(cors, {
    origin: appConfig.security.corsOrigin === '*' ? true : appConfig.security.corsOrigin,
    credentials: true,
  });

  await fastify.register(rateLimit, {
    max: appConfig.rateLimit.max,
    timeWindow: appConfig.rateLimit.windowMs,
    errorResponseBuilder: () => ({
      error: 'Rate limit exceeded',
      message: `Too many requests, please try again later.`,
    }),
  });

  await fastify.addHook('preHandler', correlationMiddleware);
  await fastify.addHook('preHandler', metricsMiddleware);
  await fastify.addHook('onResponse', metricsResponseHook);

  // Initialize vector store using factory
  const embeddingService = createVectorStore(appConfig.database);
  await embeddingService.initialize();
  
  logger.info({ 
    vectorStore: appConfig.database.type,
    dimension: appConfig.database.dimension 
  }, 'Vector store initialized');

  // Initialize embedding generation service if enabled
  let embeddingGenerationService: EmbeddingGenerationService | null = null;
  let embeddingWriteQueue: EmbeddingWriteQueueManager | null = null;
  
  if (appConfig.embeddingGeneration?.enabled) {
    embeddingGenerationService = new EmbeddingGenerationService(appConfig.embeddingGeneration);
    await embeddingGenerationService.initialize();

    // Initialize SQLite write queue for better parallel processing
    const queueDbPath = appConfig.embeddingGeneration.queue?.sqliteDbPath 
      || path.join(appConfig.embeddingGeneration.storage.path || './data', 'embedding-queue.db');
    
    embeddingWriteQueue = new EmbeddingWriteQueueManager(
      queueDbPath,
      embeddingService,
      {
        processIntervalMs: 1000,
        maxRetries: 3,
        insertChunkSize: appConfig.embeddingGeneration.queue?.insertChunkSize || 1000
      }
    );
    await embeddingWriteQueue.initialize();
    logger.info({
      dbPath: queueDbPath
    }, 'SQLite embedding write queue initialized');
  }

  // Initialize Supabase listener service if enabled
  let supabaseListener: SupabaseListenerService | null = null;
  
  if (appConfig.supabase?.enabled) {
    // Supabase listener requires embedding generation and write queue
    if (!embeddingGenerationService || !embeddingWriteQueue) {
      logger.warn('Supabase listener enabled but embedding generation or write queue not available. Skipping Supabase listener initialization.');
    } else {
      supabaseListener = new SupabaseListenerService(
        {
          supabaseUrl: appConfig.supabase.url,
          supabaseKey: appConfig.supabase.anonKey,
          maxTextLength: appConfig.supabase.maxTextLength,
          batchSize: appConfig.supabase.batchSize,
          flushTimeoutMs: appConfig.supabase.flushTimeoutMs,
        },
        embeddingService,
        embeddingGenerationService,
        embeddingWriteQueue
      );
      await supabaseListener.initialize();
      logger.info({
        supabaseUrl: appConfig.supabase.url,
        maxTextLength: appConfig.supabase.maxTextLength,
        batchSize: appConfig.supabase.batchSize,
        flushTimeoutMs: appConfig.supabase.flushTimeoutMs
      }, 'Supabase listener service initialized with batching');
    }
  }

  // Store services in fastify context for cross-service access
  (fastify as any).embeddingService = embeddingService;
  (fastify as any).embeddingGenerationService = embeddingGenerationService;
  (fastify as any).embeddingWriteQueue = embeddingWriteQueue;

  // Serve static files from src directory (index.html, search.js, styles.css)
  // Register BEFORE API routes so static files are available
  await fastify.register(fastifyStatic, {
    root: path.join(process.cwd(), 'src'),
    prefix: '/',
  });

  // Explicit routes for static files to ensure they're served
  fastify.get('/', async (request, reply) => {
    return reply.sendFile('index.html');
  });
  
  fastify.get('/search.js', async (request, reply) => {
    return reply.sendFile('search.js');
  });
  
  fastify.get('/styles.css', async (request, reply) => {
    return reply.sendFile('styles.css');
  });

  await fastify.register(embeddingRoutes, { embeddingService });
  await fastify.register(healthRoutes, { embeddingService });

  if (embeddingGenerationService) {
    await fastify.register(embeddingGenerationRoutes, { 
      embeddingGenerationService,
      embeddingWriteQueue: embeddingWriteQueue || undefined
    });
  }

  await fastify.ready();

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);
    
    // Shutdown Supabase listener first (unsubscribe from events)
    if (supabaseListener) {
      await supabaseListener.shutdown();
      logger.info('Supabase listener shutdown complete');
    }
    
    // Shutdown write queue (waits for current processing to complete)
    if (embeddingWriteQueue) {
      const stats = await embeddingWriteQueue.getStats();
      logger.info({
        pending: stats.queue.pending,
        processing: stats.queue.processing,
        failed: stats.queue.failed
      }, 'Final queue stats before shutdown');

      await embeddingWriteQueue.shutdown();
      logger.info('Write queue shutdown complete');
    }
    
    await fastify.close();
    await embeddingService.close();
    await closeMetrics();
    await shutdownTracing();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { fastify, embeddingService, embeddingGenerationService };
}

export async function startServer() {
  try {
    const { fastify } = await createServer();

    await fastify.listen({
      port: appConfig.server.port,
      host: appConfig.server.host,
    });

    logger.info({
      port: appConfig.server.port,
      host: appConfig.server.host,
      environment: appConfig.server.environment,
    }, 'Server started successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}
