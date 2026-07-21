FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm ci --workspace @facereel/db --workspace @facereel/storage --workspace @facereel/worker \
  && npm rebuild @tensorflow/tfjs-node
COPY prisma.config.ts ./
COPY packages/db packages/db
COPY packages/storage packages/storage
COPY packages/worker packages/worker
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

FROM node:22.16.0-bookworm-slim AS worker
ENV NODE_ENV=production PORT=8080 FACEAPI_MODEL_DIR=/app/models/face-api
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system facereel \
  && useradd --system --gid facereel --home /app facereel
COPY --from=build --chown=facereel:facereel /app/node_modules ./node_modules
COPY --from=build --chown=facereel:facereel /app/packages ./packages
COPY --chown=facereel:facereel models ./models
USER facereel
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["./node_modules/.bin/tsx","packages/worker/src/server.ts"]
