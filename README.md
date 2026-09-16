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

- Node.js 22.22.2 or newer
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

## LecSSO 浏览器登录（Phase 1）

登录入口为 `/api/auth/oidc/login`，固定 callback 为 `${APP_URL}/api/auth/oidc/callback`，客户端 ID 为 `lec-doc`。本地密码登录、重置密码、注册和邀请注册接口已关闭。

额外设置以下环境变量（secret 仅注入服务端，不写入版本库）：

| 变量 | 用途 |
| --- | --- |
| `APP_URL` | 浏览器访问的精确 HTTPS origin，不带末尾 `/` |
| `LEC_DOC_OIDC_ISSUER` | LecSSO 的 HTTPS realm issuer |
| `LEC_DOC_CLIENT_SECRET` | 与 LecSSO confidential client 对应的 secret |
| `ALLOWED_PRIVATE_NETWORKS` | 内网 IdP 所需的明确 CIDR 白名单，默认拒绝私有地址 |

HTTP、Socket.IO 和 Hocuspocus 共用 exact Origin；Cookie 认证的写请求还必须携带 `x-lec-csrf`，值来自可读 `lecCsrf` Cookie。身份由 `(workspace, issuer, sub)` 唯一绑定，邮箱冲突返回中文错误，不自动合并。首次登录的用户、默认组和绑定在同一数据库事务创建，用户没有本地密码且默认角色为 member。

本地自签 CA 必须在 **Node 启动前** 通过进程环境设置 `NODE_EXTRA_CA_CERTS`，不能仅放入 `node --env-file`。不要关闭 TLS 校验。Web 与 API 应经同源 HTTPS 代理访问。

真实数据库检查使用专用测试数据库/Redis：

```bash
DATABASE_URL="$LEC_DOC_TEST_DATABASE_URL" pnpm migration:latest
LEC_DOC_TEST_DATABASE_URL=postgres://... LEC_DOC_TEST_REDIS_URL=redis://... pnpm test --runInBand
```

CI 启动 PostgreSQL/Redis 执行这些集成测试。未提供测试环境变量时对应集成套件会跳过，不能视为真实栈验收。Lec identity 类型通过 `pnpm migration:codegen:lec` 从迁移后的数据库生成。

Phase 1 只完成身份和会话边界；Core 授权、资源生命周期和实时撤权仍在后续阶段，当前版本不可作为完整生产授权方案部署。
