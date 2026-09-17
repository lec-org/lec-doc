# syntax=docker/dockerfile:1
ARG VCS_REF
ARG PLATFORM_VCS_REF
ARG EDITOR_VCS_REF
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
ARG VCS_REF
ARG PLATFORM_VCS_REF
ARG EDITOR_VCS_REF
RUN for ref in "$VCS_REF" "$PLATFORM_VCS_REF" "$EDITOR_VCS_REF"; do printf '%s\n' "$ref" | grep -Eq '^[0-9a-f]{40}$'; done
LABEL org.opencontainers.image.source="https://github.com/lec-org/lec-doc" \
      org.opencontainers.image.revision="$VCS_REF" \
      io.lec.platform.revision="$PLATFORM_VCS_REF" \
      io.lec.doc-editor.revision="$EDITOR_VCS_REF"
WORKDIR /workspace
RUN --mount=type=secret,id=npm_ca,required=false,target=/tmp/npm-ca.pem \
    test ! -s /tmp/npm-ca.pem || export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; \
    corepack enable && corepack prepare pnpm@11.25.0 --activate

# Build from the parent platform root. The editor is a local file dependency.
COPY packages/lec-doc-editor packages/lec-doc-editor
COPY services/lec-doc services/lec-doc
WORKDIR /workspace/services/lec-doc
RUN --mount=type=secret,id=npm_ca,required=false,target=/tmp/npm-ca.pem \
    test ! -s /tmp/npm-ca.pem || export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; \
    pnpm --dir ../../packages/lec-doc-editor install --frozen-lockfile && pnpm --dir ../../packages/lec-doc-editor build && pnpm install --frozen-lockfile && cp -R ../../packages/lec-doc-editor/dist node_modules/@lec/doc-editor/dist && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
ARG VCS_REF
ARG PLATFORM_VCS_REF
ARG EDITOR_VCS_REF
LABEL org.opencontainers.image.source="https://github.com/lec-org/lec-doc" \
      org.opencontainers.image.revision="$VCS_REF" \
      io.lec.platform.revision="$PLATFORM_VCS_REF" \
      io.lec.doc-editor.revision="$EDITOR_VCS_REF"
ENV NODE_ENV=production
WORKDIR /workspace/services/lec-doc
COPY --from=build /workspace/services/lec-doc/package.json ./package.json
COPY --from=build /workspace/services/lec-doc/node_modules ./node_modules
COPY --from=build /workspace/services/lec-doc/dist ./dist
COPY --from=build /workspace/packages/lec-doc-editor /workspace/packages/lec-doc-editor
RUN mkdir -p data/storage
EXPOSE 3000 3001 3002
CMD ["node", "dist/main.js"]
