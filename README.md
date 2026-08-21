# CA_Embed - Production-Ready Embeddings Service

A high-performance, scalable embeddings serving solution built with TypeScript and Bun. Uses Qdrant as the vector database backend with comprehensive observability and production-ready features.

## 🚀 Features

- **Qdrant Vector Database**: Cloud-native vector database with advanced features
- **High Performance**: Handle billion-scale vector searches efficiently
- **Advanced Search**: Metadata filtering and payload-based search
- **Production Ready**: Rate limiting, health checks, graceful shutdown
- **Full Observability**: Metrics, tracing, structured logging, dashboards
- **Type Safe**: Full TypeScript implementation with Zod validation
- **Containerized**: Docker deployment with multi-stage builds
- **Scalable Architecture**: Built for distributed systems and horizontal scaling
- **Cloud Backups**: Export vector store to Cloudflare R2 or Supabase Storage via API

## Search attribution telemetry

Search logs include a daily rotating,
16-character HMAC of client IP plus user agent, a coarse client category, and
origin/referrer hostnames. Raw IP addresses, full user agents, URL paths, and
search terms are not logged. The HMAC secret exists only in process memory and
changes whenever the service restarts.

## 📊 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CA_Embed Service                       │
├─────────────────────────────────────────────────────────────┤
│  Fastify API Server + Middleware (CORS, Rate Limit, etc.)  │
├─────────────────────────────────────────────────────────────┤
│  Vector Store Factory (Plugin Architecture)                │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐       │
│  │         Qdrant Vector Store                     │       │
│  │         (Cloud-Native, Feature-Rich)            │       │
│  └─────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Observability Stack                      │
├─────────────────────────────────────────────────────────────┤
│  Prometheus (Metrics) + Grafana (Dashboards)              │
│  Jaeger (Distributed Tracing) + Structured Logs          │
└─────────────────────────────────────────────────────────────┘
```

### Vector Store Backend

**Qdrant** - Cloud-native vector database
- Collection-based storage with indexing
- Advanced metadata filtering and payload search
- Horizontal scalability
- Billion-scale vector support
- Cloud and self-hosted options
- Best for: Production deployments, advanced filtering needs, distributed systems

**ClickHouse** - Compact analytical vector serving
- Existing `POST /embeddings/search` request and response contract
- Binary HNSW index with Qdrant-compatible cosine similarity scores
- Payload hydration and Qdrant-style metadata filters
- Best for: Colocating an infrequently queried vector corpus with analytical storage

**LanceDB** - Disk-first local vector serving
- Cosine IVF-RQ index with one-bit RaBitQ candidate search and exact refinement
- ClickHouse payload hydration and filtered-search fallback preserve the API contract
- Inserts and deletes write through to ClickHouse so rollback remains current
- Best for: Low-memory, low-latency unfiltered semantic search on a single SSD host

Production configuration, validation gates, monitoring and rollback are documented
in [`ops/lancedb-vector/README.md`](ops/lancedb-vector/README.md).

## 🛠 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (v1.2.5+)
- [Docker](https://docker.com/) (optional, for containerized deployment)

### Local Development

1. **Clone and Install**
   ```bash
   git clone <repository>
   cd ca_embed
   bun install
   ```

2. **Start Qdrant**
   ```bash
   # Using Docker
   docker run -p 6333:6333 -p 6334:6334 \
     -v $(pwd)/qdrant_storage:/qdrant/storage:z \
     qdrant/qdrant
   ```

3. **Environment Setup**
   ```bash
   # Create .env file with your configuration
   
   # Minimum required:
   VECTOR_STORE=qdrant
   VECTOR_DIMENSION=1024
   QDRANT_URL=http://localhost:6333
   QDRANT_COLLECTION_NAME=embeddings
   ```

4. **Start Development Server**
   ```bash
   bun run dev
   ```

5. **Run Tests**
   ```bash
   bun test
   ```

### Docker Deployment

1. **Full Stack with Observability**
   ```bash
   cd docker
   docker-compose up -d
   ```

2. **Access Services**
   - API: http://localhost:3000
   - Metrics: http://localhost:3000/metrics
   - Qdrant: http://localhost:6333/dashboard
   - Grafana: http://localhost:3001 (admin/admin)
   - Jaeger: http://localhost:16686
   - Prometheus: http://localhost:9091

## 📡 API Reference

### Insert Embeddings
```bash
POST /embeddings
Content-Type: application/json

{
  "embeddings": [
    {
      "key": "doc1",
      "vector": [0.1, 0.2, 0.3, ...],
      "metadata": {"category": "text"}
    }
  ]
}
```

### Search Similar Vectors
```bash
POST /embeddings/search
Content-Type: application/json

{
  "vector": [0.1, 0.2, 0.3, ...],
  "k": 10,
  "threshold": 0.8,
  "filter": {              # Optional metadata filter
    "category": "technology",
    "year": 2024
  }
}
```

**Note**: LanceDB owns vector search. Results are hydrated and policy-filtered
against the canonical tweet ClickHouse projection; filtered searches hydrate a
bounded Lance candidate set before applying the existing filter behavior.

**For detailed search API documentation with advanced filtering examples, see [docs/SEARCH_API.md](docs/SEARCH_API.md).**

### Delete Embeddings
```bash
DELETE /embeddings
Content-Type: application/json

{
  "keys": ["doc1", "doc2"]
}
```

### Health & Stats
```bash
GET /health              # Health check
GET /health/readiness    # Kubernetes readiness probe
GET /health/liveness     # Kubernetes liveness probe
GET /embeddings/stats    # Database statistics
GET /metrics             # Prometheus metrics
```

## ⚙ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| **Server** | | |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `NODE_ENV` | `development` | Environment mode |
| **Vector Store** | | |
| `VECTOR_STORE` | `qdrant` | Backend type (`qdrant`, `clickhouse`, or `lancedb`) |
| `VECTOR_DIMENSION` | `1024` | Vector dimensions |
| **Qdrant Configuration** | | |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `QDRANT_API_KEY` | - | API key (for Qdrant Cloud) |
| `QDRANT_COLLECTION_NAME` | `embeddings` | Collection name |
| `QDRANT_TIMEOUT` | `30000` | Request timeout (ms) |
| **ClickHouse Configuration** | | |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_USER` | `default` | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | - | ClickHouse password |
| `CLICKHOUSE_DATABASE` | `vector_bench` | Vector database |
| `CLICKHOUSE_VECTOR_TABLE` | `vectors` | Vector table |
| `CLICKHOUSE_PAYLOAD_TABLE` | `payloads` | Key and metadata table |
| `CLICKHOUSE_TIMEOUT` | `30000` | Request timeout (ms) |
| `CLICKHOUSE_SEARCH_CANDIDATES` | `256` | HNSW candidates retained for exact rescoring |
| **LanceDB Configuration** | | |
| `LANCEDB_URI` | `./data/lancedb` | Local LanceDB database directory |
| `LANCEDB_TABLE` | `vectors` | Lance table containing IDs and vectors |
| `LANCEDB_NPROBES` | `64` | IVF partitions probed per search |
| `LANCEDB_REFINE_FACTOR` | `2` | Full-vector exact reranking multiplier |
| `LANCEDB_OPTIMIZE_AFTER_ROWS` | `100000` | Modified-row threshold for background optimize |
| `LANCEDB_OPTIMIZE_AFTER_MUTATIONS` | `1000` | Mutation-operation threshold for background optimize |
| `TWEET_CLICKHOUSE_URL` | `http://localhost:18123` | Read-only canonical tweet ClickHouse endpoint |
| `TWEET_CLICKHOUSE_USER` | `default` | Canonical tweet ClickHouse user |
| `TWEET_CLICKHOUSE_PASSWORD` | - | Canonical tweet ClickHouse password |
| `TWEET_CLICKHOUSE_DATABASE` | `community_archive` | Canonical tweet database |
| `TWEET_CLICKHOUSE_TIMEOUT` | `30000` | Canonical hydration timeout (ms) |
| `TWEET_CLICKHOUSE_HYDRATION_BATCH_SIZE` | `100` | IDs per canonical hydration query |
| `LANCEDB_FILTER_CANDIDATES` | `256` | Lance candidates hydrated for filtered searches |
| **Observability** | | |
| `ENABLE_METRICS` | `true` | Enable Prometheus metrics |
| `ENABLE_TRACING` | `true` | Enable OpenTelemetry tracing |
| `LOG_LEVEL` | `info` | Logging level |
| **Rate Limiting** | | |
| `RATE_LIMIT_MAX` | `100` | Requests per window |
| `RATE_LIMIT_WINDOW` | `60000` | Rate limit window (ms) |
| **Cloud Export (R2)** | | |
| `R2_ACCESS_KEY_ID` | - | Cloudflare R2 access key |
| `R2_SECRET_ACCESS_KEY` | - | Cloudflare R2 secret key |
| `R2_ENDPOINT` | - | R2 endpoint URL (e.g., `https://xxx.r2.cloudflarestorage.com`) |
| `R2_BUCKET` | - | R2 bucket name |
| **Cloud Export (Supabase)** | | |
| `SUPABASE_URL` | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | - | Supabase service role key (for storage access) |
| `SUPABASE_STORAGE_BUCKET` | - | Supabase storage bucket name |

## 🔧 Production Deployment

### Requirements

- **Memory**: Minimum 8GB, recommended 16GB+
- **CPU**: 4+ cores recommended
- **Storage**: SSD recommended for database
- **Network**: Low latency for optimal performance

### Deployment Steps

1. **Build Production Image**
   ```bash
   docker build -t ca_embed:latest .
   ```

2. **Deploy with Docker Compose**
   ```bash
   docker-compose -f docker/docker-compose.yml up -d
   ```

3. **Configure Monitoring**
   - Set up Prometheus scraping
   - Configure Grafana dashboards
   - Set up alerting rules

### Backup & Recovery

**Cloud Export via API**

Export your entire vector store to Cloudflare R2 or Supabase Storage for disaster recovery. Export uses a high-performance Go binary that runs in the background.

**Configuration:**
```bash
# R2 credentials (for R2 export)
R2_ACCESS_KEY_ID=your_key
R2_SECRET_ACCESS_KEY=your_secret
R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com
R2_BUCKET=your_bucket

# Supabase credentials (for Supabase export)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_STORAGE_BUCKET=your_bucket
```

**Start Export** (Protected, requires API key):
```bash
# Export to R2
curl -X POST http://localhost:3000/embeddings/export \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"destination": "r2", "strategy": "parquet-med"}'

# Export to Supabase
curl -X POST http://localhost:3000/embeddings/export \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"destination": "supabase"}'
```

**R2 Export Strategies:**
- `ndjson-gz` - Compressed newline-delimited JSON
- `parquet-small` - Small parquet chunks
- `parquet-med` - Medium parquet chunks (default)
- `parquet-large` - Large parquet chunks

**Check Export Status:**
```bash
curl http://localhost:3000/embeddings/export/status \
  -H "Authorization: Bearer your-api-key"
```

**Cancel Running Export:**
```bash
curl -X DELETE http://localhost:3000/embeddings/export \
  -H "Authorization: Bearer your-api-key"
```

## 📈 Monitoring & Observability

### Key Metrics

- **Performance**: Request rate, latency (P95, P99), error rate
- **Business**: Vector count, search accuracy, database size
- **System**: CPU, memory, disk I/O, active connections

### Available Dashboards

1. **Service Overview**: Request metrics, error rates, latency
2. **Database Performance**: Vector operations, search times
3. **System Resources**: CPU, memory, disk usage
4. **Alerts**: Critical issues, SLA violations

### Log Structure

```json
{
  "level": "info",
  "timestamp": "2023-12-01T12:00:00.000Z",
  "correlationId": "abc-123",
  "operation": "search",
  "duration": 12.5,
  "resultCount": 10,
  "msg": "Search completed successfully"
}
```

## 🧪 Testing

```bash
# Unit tests
bun test

# Integration tests
bun run test:integration

# Load testing (requires k6)
k6 run tests/load/search.js
```

## 🚦 Health Checks

The service provides multiple health check endpoints:

- `/health` - Overall service health
- `/health/readiness` - Ready to accept traffic
- `/health/liveness` - Service is alive

## ⚠️ Current Limitations

- **Qdrant Dependency**: Requires a running Qdrant instance
- **Network Latency**: Performance depends on network latency to Qdrant server
- **Resource Requirements**: Qdrant needs dedicated resources for optimal performance

## 🔒 Security Features

- Input validation with Zod schemas
- Rate limiting per IP
- CORS protection
- Helmet security headers
- Request correlation IDs
- Structured audit logging

## 📊 Performance Characteristics

- **Latency**: Low latency for search operations (depends on Qdrant configuration)
- **Throughput**: High throughput with horizontal scaling
- **Scale**: Billion-scale vector support
- **Accuracy**: High recall with HNSW indexing
- **Filtering**: Advanced metadata filtering without performance degradation

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request


## 🆘 Support

- **Issues**: Create GitHub issues for bugs
- **Discussions**: Use GitHub discussions for questions
- **Documentation**:
  - [Search API Guide](docs/SEARCH_API.md) - Complete guide for search endpoint with advanced filtering
  - Check `/docs` for additional detailed guides
