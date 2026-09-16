# syntax=docker/dockerfile:1
ARG VCS_REF=unknown
FROM node:22-bookworm-slim AS build
ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/lec-org/lec-doc" \
      org.opencontainers.image.revision="$VCS_REF"
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

# Build from the parent platform root. The editor is a local file dependency.
COPY packages/lec-doc-editor packages/lec-doc-editor
COPY services/lec-doc services/lec-doc
WORKDIR /workspace/services/lec-doc
RUN pnpm install --frozen-lockfile && pnpm --dir ../../packages/lec-doc-editor build && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/lec-org/lec-doc" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production
WORKDIR /workspace/services/lec-doc
COPY --from=build /workspace/services/lec-doc/package.json ./package.json
COPY --from=build /workspace/services/lec-doc/node_modules ./node_modules
COPY --from=build /workspace/services/lec-doc/dist ./dist
COPY --from=build /workspace/packages/lec-doc-editor /workspace/packages/lec-doc-editor
RUN mkdir -p data/storage
EXPOSE 3000 3001
CMD ["node", "dist/main.js"]
