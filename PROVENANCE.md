# Provenance

Lec export and modification date: 2026-09-16.

## Upstream

This service is derived from the Community-licensed portions of [Docmost](https://github.com/docmost/docmost), package version **0.96.0**, at upstream revision:

- Describe: `v0.96.0-1-g6205bb`
- Commit: `6205bbeb908fe846f87dd6a2cbf562e24777db38`

The imported source remains subject to the GNU Affero General Public License v3.0. Local changes are distributed under the same license; see [`LICENSE`](LICENSE).

## Extraction and renaming

The upstream `apps/server` tree was extracted into the parent platform as standalone service `services/lec-doc`. Imports of upstream `@docmost/editor-ext` were renamed to `@lec/doc-editor`, resolved from the sibling Community package `file:../../packages/lec-doc-editor`.

## Intentionally omitted

No proprietary Enterprise source is copied or included. The private Enterprise tree and Enterprise-licensed formula package are absent. The following hooks and API/worker branches that only delegated to unavailable Enterprise code were removed:

- Enterprise module bootstrap and license implementation loading
- API-key and OAuth access-token validation
- MFA login delegation
- Typesense search and its queue/configuration path (PostgreSQL search remains)
- Bases realtime bridge and queue constants
- attachment content indexing
- Confluence, DOCX, and PDF import
- PDF export processing (HTML and Markdown export remain)
- page-verification reconciliation scheduler

The Community-facing license/entitlement response shape remains as a deterministic safe-deny shim: no Enterprise features are enabled, and self-hosted installations report the free tier. `NoopAuditModule` is used until a platform-native LEC audit implementation is provided.

Database migrations and generated database types are retained for schema compatibility. Their presence does not enable omitted Enterprise services or routes.
