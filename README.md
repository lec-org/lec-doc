# LEC Doc server

Standalone Community backend service derived from [Docmost](https://github.com/docmost/docmost) 0.96.0.
It provides the NestJS/Fastify API and collaboration server used by the parent platform. The service is licensed under the GNU Affero General Public License v3.0; see [`LICENSE`](LICENSE) and [`PROVENANCE.md`](PROVENANCE.md).

## Included

- NestJS/Fastify API
- PostgreSQL with Kysely migrations
- Redis and BullMQ jobs
- Hocuspocus/Yjs collaboration and history
- Socket.IO page-tree realtime events
- PostgreSQL search, comments, history, attachments, sharing, and public spaces
- Markdown/HTML and generic/Notion ZIP import
- HTML/Markdown page and space export

Enterprise-only integrations are intentionally absent. See [`PROVENANCE.md`](PROVENANCE.md) for the exact omissions.

## Repository layout

This service is expected at `services/lec-doc` in the parent platform. Its Community editor dependency is expected at `packages/lec-doc-editor` and is referenced as:

```json
"@lec/doc-editor": "file:../../packages/lec-doc-editor"
```

No web client source or build output is required. If a separately built `client/dist` happens to be mounted at the legacy location, the existing static module can serve it; otherwise the API and collaboration services run without it.

## Requirements

- Node.js 22.13 or newer
- pnpm 11.25.0
- PostgreSQL
- Redis

## Setup

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
cp .env.example .env # when the parent platform provides one
pnpm migration:latest
pnpm build
```

At minimum configure `DATABASE_URL`, `APP_SECRET`, and `REDIS_URL`. Environment loading is rooted at this service directory (`services/lec-doc/.env`) when commands run there.

## Run

```bash
# API, default port 3000
pnpm start:prod

# collaboration service, default port 3001
pnpm collab:prod
```

For development use `pnpm start:dev`. The collaboration entry point is included in the same build.

## Test

```bash
pnpm build
pnpm test --runInBand
```

## Container

Build from the parent platform root so the local editor package is inside the Docker build context:

```bash
docker build -f services/lec-doc/Dockerfile -t lec-doc .
docker run --rm -p 3000:3000 --env-file services/lec-doc/.env lec-doc
```

Run the collaboration service from the same image by overriding the command:

```bash
docker run --rm -p 3001:3001 --env-file services/lec-doc/.env \
  lec-doc node dist/collaboration/server/collab-main.js
```

The image does not copy or build a frontend client.
