FROM node:24.20.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/operations/package.json packages/operations/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000

CMD ["node", "scripts/start-role.mjs"]
