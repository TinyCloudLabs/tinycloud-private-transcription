FROM oven/bun:1.3-alpine AS base
# ffmpeg: the Tinfoil batch path decodes Vexa's opus/webm recording once and cuts it per speaker turn.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle.config.ts tsconfig.json ./
ENV NODE_ENV=production
# API by default; the worker service overrides CMD.
CMD ["bun", "run", "src/api/server.ts"]
