# gb-pmo 构建物：前端 dist/ + 后端生产依赖（单容器单进程，tech-architecture/deployment.md）
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# S19：容器时区固定北京（cron 调度与本地时间格式化）
ENV TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 tini curl tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
# Agent skill 包源必须打进镜像（agent-integration.md：COPY skills ./skills）
COPY --from=build /app/skills ./skills
COPY package*.json ./
RUN useradd -m appuser && mkdir -p /app/data && chown -R appuser:appuser /app
USER appuser
VOLUME /app/data
EXPOSE 8086
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8086/api/v1/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.mjs"]
