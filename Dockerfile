# syntax=docker/dockerfile:1.10
# Multi-stage Dockerfile for LX Music Web Server (Ultra-slim Bun Architecture)

ARG BUN_VERSION=1.4.2

# Stage 1: Build Frontend, Server bundle and assets on host platform
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS builder
WORKDIR /app

# 安装构建可能需要的编译工具链
RUN apk add --no-cache \
  g++ \
  make \
  python3

# 利用 BuildKit 缓存挂载加速依赖安装（全量依赖用于编译）
COPY package.json bun.lock tsconfig.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile

COPY . .

# 1. 使用 Bun 原生 Bundler 极速构建前端资源
RUN bun run build:frontend

# 2. 将服务端核心源码编译打包为单文件 (外部依赖保留 external)
RUN bun run build

# Stage 2: Production Dependencies (仅安装生产依赖，剥离巨大 TS 编译器及类型库)
FROM oven/bun:${BUN_VERSION}-alpine AS prod-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --production --frozen-lockfile && \
  find node_modules -type f \( -name "*.map" -o -name "*.md" -o -name "*.ts" ! -name "*.d.ts" \) -delete 2>/dev/null || true

# Stage 3: Ultra-slim Production Runner
FROM oven/bun:${BUN_VERSION}-alpine AS runner
WORKDIR /server

RUN apk add --no-cache \
  chromaprint \
  gcompat \
  libstdc++

# 仅复制纯净生产依赖、编译打包产物与必要运行时配置，彻底剔除 src/、开发依赖与构建脚本
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public

# 将系统 chromaprint (fpcalc) 直接软链接至播放器二进制目录，免去容器内外部下载
RUN mkdir -p /server/public/music/bin && ln -sf /usr/bin/fpcalc /server/public/music/bin/fpcalc

# 生产进程使用非 root 用户；挂载目录需要由宿主机授予该用户写权限。
RUN addgroup -S lx && adduser -S -G lx lx && \
  mkdir -p /server/data /server/cache /server/music /server/cover_cache && \
  chown -R lx:lx /server

# /server/cache 与 /server/music 位于工作目录之下，不在 /server/data 内：
# 前者是歌曲缓存根目录，后者是仅下载模式下保存的音乐文件目录。
# 未声明为卷时，容器重建会连带清空这两个目录。
VOLUME /server/data
VOLUME /server/cache
VOLUME /server/music
ENV DATA_PATH='/server/data'
ENV CONFIG_PATH='/server/data/config.js'
ENV LOG_PATH='/server/data/logs'
ENV NODE_ENV='production'
ENV PORT=9527
ENV BIND_IP='0.0.0.0'

EXPOSE 9527

# 容器原生健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:9527/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

USER lx
CMD [ "bun", "server/index.js" ]
