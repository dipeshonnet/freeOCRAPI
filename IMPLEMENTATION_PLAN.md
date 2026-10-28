# FreeOCRapi implementation plan

Approved 2026-10-27. Reference FreeLLMAPI commit 2359d30.

## Sequential milestones

1. Foundation: isolated workspace, reference attribution/design tokens, typed OCR contracts, reproducible scripts, checkpoint files, buildable web/server shell.
2. Persistence and accounts: SQLite migrations, encrypted credentials, setup/login/reset, unified API key, settings, models and profiles.
3. Local document processing: uploads, format/page validation, Tesseract with bundled English data, PDF rendering, normalized results and downloads.
4. Durable routing/jobs: persistent queue, one engine per document, sequential safe failover, quotas, reservations, cancellation, restart recovery and cache.
5. Provider adapters: LlamaParse, Mistral, OCR.space, Azure, Google Document AI, Textract, PaddleOCR, Docling and custom service; fixtures and capability declarations.
6. Dashboard parity: engines/capability tabs/details, playground/result viewer/batches, keys, agents, routing rules/profiles, document search, analytics/logs, catalog/updates/settings and all action states.
7. Operations: retention, image preprocessing, encrypted backup/restore, proxy settings, health checks, catalog import/export, localization and command palette.
8. API/integrations: OpenAPI docs, MCP, Python LlamaIndex/LangChain/Haystack readers, CLI processing/configuration/diagnostics.
9. Desktop/distribution: tray/dashboard, independent app identity/data, packaging, Docker/optional sidecars and CI.
10. End-to-end verification and handoff: real local OCR, integration tests, browser screenshots, builds, installer where feasible, accurate limitations.

## Required screen mapping

- Authentication: setup/login/reset; desktop automatic local sign-in.
- Models -> Engines: overview + detail, quotas, health, strategy, filters and toggles.
- Image -> image OCR; Video -> multipage/batch; Audio -> handwriting; Embeddings -> structured extraction; Search -> document history; Decision -> routing rules; Fusion -> sequential profiles.
- Playground -> upload, source preview, options, progress, normalized result tabs and downloads.
- Keys -> encrypted provider credentials, unified key, checks, import/export and limits.
- Agents -> framework/REST/MCP integration cards and real examples.
- Analytics/logs -> measured OCR requests/pages/latency/success/attempts/usage.
- Premium -> OCR catalog/import/export/updates, no commercial service.
- Settings -> theme/language/preprocessing/cache/retention/proxy/backups/updates.

## Architecture/defaults

React/Vite + Express/TypeScript + SQLite + shared contracts. Server :3002, UI :5174, desktop :31416 with conflict detection. Default one worker; PDF/PNG/JPEG/WebP/TIFF, 50MB/100 pages. Built-in English Tesseract plus language management. Optional cloud keys and local services are unconfigured until supplied. Preserve provider provenance and missing-value semantics. No confidence/quality/remaining-quota fabrication. Requests/pages/credits accounted separately; optional caps 0=unlimited. Default retention 30 days.

Public interfaces: POST /v1/files, GET /v1/models, POST /v1/ocr, GET /v1/jobs/:id, cancel/download, POST /v1/batches, /v1/docs, /mcp. OCR jobs accept uploaded files or guarded public URLs, explicit engines or auto profiles. Persist upstream operation IDs; do not start a replacement when an earlier submission may still be running.

Preserve MIT attribution and familiar top navigation/Geist typography/monochrome cards/rounded tables/dark and light themes/responsive layouts. Reuse suitable source without transferring secrets/runtime data. Every milestone must leave a resumable state and include meaningful verification. Live cloud tests require configured accounts; native non-Windows builds require matching CI runners. Do not publish anything automatically.
