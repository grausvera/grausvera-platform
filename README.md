# grausvera platform

grausvera platform is a modular TypeScript application with independently runnable web and worker
processes. Product behavior is being built incrementally; the current repository contains the R1
technical foundation only.

## Requirements

- Node.js and npm versions from `.nvmrc` and `packageManager`.
- Docker with Compose v2 for local PostgreSQL and S3-compatible object storage.

Copy `.env.example` to `.env` for local development. Every value in the example is synthetic and
must never be reused outside a local environment.

## Local infrastructure

Start isolated PostgreSQL and S3Mock services:

```sh
docker compose up -d --wait
```

Apply every versioned SQL migration to the empty database:

```sh
npm run db:migrate
```

Stop the services while retaining their project-scoped volumes:

```sh
docker compose down
```

To run another isolated stack, select a unique project and host ports:

```sh
COMPOSE_PROJECT_NAME=grausvera-platform-check \
POSTGRES_PORT=55432 \
S3_PORT=59090 \
docker compose up -d --wait
```

Use the same `POSTGRES_PORT` in `DATABASE_URL` when migrating that stack. Remove an isolated
stack's data only by naming that exact project:

```sh
COMPOSE_PROJECT_NAME=grausvera-platform-check docker compose down --volumes
```

S3Mock is a local test double. It uses path-style requests and does not represent production
security, presigned URL validation, or Cloudflare R2 acceptance.

## Repository checks

```sh
npm ci --ignore-scripts
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run test:e2e
```

Suites whose first capability has not been implemented exit with a `PENDING` message and a nonzero
status. They are not green placeholders.

## Operational foundation

Runtime configuration is validated before the worker starts. `DATABASE_URL` is required; `APP_ROLE`
accepts only `web` or `worker`, and `LOG_LEVEL`, `NODE_ENV`, and `PORT` use the values documented in
`.env.example`. Startup failures produce a generic structured event instead of printing the invalid
configuration or a provider error.

After building, enqueue the foundation's synthetic durable job:

```sh
npm run job:enqueue:synthetic
```

Start the worker with `APP_ROLE=worker npm run start --workspace @grausvera/worker`. `SIGINT` and
`SIGTERM` stop new queue work, wait for active work, and close pg-boss before the process exits.

The web readiness endpoint is `GET /api/health`. It returns `200` only while PostgreSQL is reachable
and `503` otherwise. Responses contain a status and opaque correlation ID, never connection details.

Build the single OCI image and select its runtime role explicitly:

```sh
docker build --tag grausvera-platform:local .
docker run --rm --env-file .env --env APP_ROLE=web --publish 3000:3000 grausvera-platform:local
docker run --rm --env-file .env --env APP_ROLE=worker grausvera-platform:local
```

The database hostname in `.env` must be reachable from the container network. The image runs as the
unprivileged `node` user and exits with a nonzero status when `APP_ROLE` is missing or invalid.
