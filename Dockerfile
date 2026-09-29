FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS base
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle.config.ts tsconfig.json ./
ENV NODE_ENV=production
# API by default; the worker service overrides CMD.
CMD ["bun", "run", "src/api/server.ts"]
