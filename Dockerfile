FROM oven/bun:1.2.5-alpine AS base

WORKDIR /app

# Build Go exporter binaries
FROM golang:1.23-alpine AS go-builder
WORKDIR /build
COPY scripts/go/go.mod scripts/go/go.sum ./
RUN go mod download
COPY scripts/go/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o qdrant_exporter_r2 qdrant_exporter_r2.go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o qdrant_exporter_supabase qdrant_exporter_supabase.go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o qdrant_downloader qdrant_downloader.go

FROM base AS deps
COPY package.json bun.lock ./
# Alpine loads the musl LanceDB binding; omit the unused glibc binary.
RUN bun install --frozen-lockfile --production \
  && rm -rf /app/node_modules/@lancedb/lancedb-linux-x64-gnu

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM base AS runtime
RUN addgroup --system --gid 1001 ca_embed
RUN adduser --system --uid 1001 ca_embed

COPY --from=deps --chown=ca_embed:ca_embed /app/node_modules ./node_modules
COPY --from=build --chown=ca_embed:ca_embed /app/src ./src
COPY --from=build --chown=ca_embed:ca_embed /app/package.json ./

# Copy Go binaries (same path as project folder)
COPY --from=go-builder --chown=ca_embed:ca_embed /build/qdrant_exporter_r2 /app/scripts/go/
COPY --from=go-builder --chown=ca_embed:ca_embed /build/qdrant_exporter_supabase /app/scripts/go/
COPY --from=go-builder --chown=ca_embed:ca_embed /build/qdrant_downloader /app/scripts/go/

RUN mkdir -p data && chown ca_embed:ca_embed data

USER ca_embed

EXPOSE 3000 9090

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
