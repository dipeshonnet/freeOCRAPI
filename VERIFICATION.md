# Verification evidence

Windows x64, Node.js 24.19.0. Verification checkpoint finalized 2026-10-28 (Asia/Calcutta).

## Rebuilt Windows packages — 2026-10-28

- Production build passed. Full Windows packaging refreshed the application/ZIP; NSIS failed at generated-helper launch. A direct helper diagnostic was rejected by automatic approval review and was not executed.
- `scripts/package-desktop.mjs` now uses electron-builder's file-only `UninstallerReader` for NSIS uninstaller extraction. The installer-only retry passed without executing the generated installer. `node --check scripts/package-desktop.mjs` passed.
- `node scripts/desktop-smoke.mjs` passed (ready, tray, local sign-in, embedded API, exit code 0); `node scripts/packaged-engine-smoke.mjs` passed (real document text includes 2026). Both used isolated test data.
- `python scripts/verify-packages.py --sevenzip <path-to-7za.exe>` passed: 37 application/runtime files and package metadata match in the unpacked app, installer and portable ZIP. The verifier extracts and hashes files; it does not install/execute the installer. Latest evidence is in `artifacts/package-verification.json`, `artifacts/package-file-manifest.json` and `artifacts/checksums.json`.
- Installer: 214675390 bytes, SHA-256 `1a5fcf6190e71d40174a9bb5b3ac1f2deedca33c92041b761c7ed5a245ebdb18`. ZIP: 271256310 bytes, SHA-256 `d568b81c11a582ed07bd92b73abcbada8dac2fc747e833c1f9fa5bacbc9e7b88`. Version remains 0.1.0; use hashes to distinguish the rebuild.
- README provider counts come from the local catalog: 1 built-in + 2 optional local + 6 cloud + 1 custom = 10; five input formats, four export formats. Five repository figures were generated and visually inspected, with a real synthetic-document OCR screenshot. Live GitHub badges refer to `dipeshonnet/freeOCRAPI`.
- Limits: unsigned packages; installer installation/uninstallation itself was not performed. macOS/Linux, live cloud, Docker/sidecar runtime and framework checks remain open. The source/regression checks below still apply; no application runtime code changed during packaging.

## Security maintenance — 2026-10-28

- Syntax/types: `node --check cli/index.mjs` and `pnpm typecheck` passed.
- Original triggers: local 301/302/303/307/308 fixtures reproduced client redirect failures before the patch; missing/false Content-Length fixtures reproduced full oversized response consumption; authenticated CSV export reproduced unprotected formula cells. After the patch the same tests reject redirects without contacting the destination, stop/cancel streams before complete consumption, and prefix dangerous CSV cells.
- Focused checks: CLI 6/6; bundled Python 3.12 `-m unittest integrations.python.test_security -v` 2/2 (five redirect subcases); networking/provider/backup 14/14; HTTP/download/OCR/routing 12/12 passed.
- Required regression/build checks: `pnpm test` passed 35/35 across eight files; `pnpm build` passed. The existing Vite large-chunk warning remains. Actual image/multipage PDF OCR, authenticated upload/download, uncertain-submission behavior, quota retention and encrypted backups still pass.
- Added regression sources: `cli/security.test.mjs`, `integrations/python/test_security.py`, `server/src/network.test.ts`, and additions in `server/src/cloud-providers.test.ts` and `server/src/app.test.ts`. Python checks are now configured in `.github/workflows/ci.yml`; hosted CI itself was not run.
- Changed enforcement: CLI/Python shared request helpers refuse gateway redirects; `server/src/network.ts` bounds streamed body bytes, used by REST provider JSON and language downloads; `server/src/jobs.ts` protects CSV cells at export. Raw OCR/JSON, direct authenticated requests, normal CSV escaping and binary model bytes were verified intact. Negative CSV numbers now export as text; configure the final gateway URL directly for CLI/Python.
- Independent read-only compatibility investigation and final bypass/regression review completed without a concrete surviving bypass or regression in scope. Reviewer also checked actual gzip expansion beyond the decoded-byte limit.
- Limits: no live provider accounts, native spreadsheet formula execution, dependency advisory audit or exhaustive managed scan. The managed Codex Security tool did not return a scan context; no managed scan/report is claimed. REST byte limits do not cover AWS/LlamaCloud SDK internals or transport chunk allocation.
- The later Windows rebuild above supersedes the earlier package evidence. Current installer/ZIP hashes and manifests include these security fixes; old package hashes in historical notes are not current downloads.

## Earlier v0.1 delivery evidence

- Server/client TypeScript checks and production dashboard build: passed.
- Automated suite: 22 tests passed.
- Actual image and two-page PDF OCR, preserving page order: passed.
- HTTP upload → persisted job → recognized text download: passed.
- Single active engine, safe fallback/resume, cancellation and restart recovery: passed.
- Monthly caps survive history retention; cache preserves provenance: passed.
- Password-authenticated encrypted backup and full credential/document restore: passed.
- CLI and standard-library Python client recognized real test pixels: passed.
- Browser checked nine main routes and inspected source/result output: passed; screenshot at `artifacts/ocr-result.png`.
- Packaged desktop boot, tray, local sign-in and embedded API: passed; `artifacts/desktop-smoke.json`.
- Packaged Node/native dependencies/offline OCR assets recognized the fixture: passed; `artifacts/packaged-ocr-smoke.json`.
- Docker Compose configuration: validated. Live Docker/sidecar builds not verified because the engine is stopped.
- Live cloud accounts, optional installed framework packages, native macOS/Linux packaging and live desktop updates: not verified.
- Active-port examples for LlamaIndex, LangChain, Haystack, MCP and CLI: verified in the browser.
- Final package integrity: 33 compiled application files match the source build in both unpacked app and portable ZIP; artifacts/package-file-manifest.json.
- Final installer and ZIP SHA-256 checksums: artifacts/checksums.json.

Windows installer generation initially failed because electron-builder 26.18 dropped SYSTEMROOT/PATH/TEMP from a subprocess environment. The project-local packaging wrapper preserves them and the installer build succeeded. Builds are unsigned and were not published.

The packaging tool initially reused an older ZIP during a prepackaged refresh. The generated ZIP was removed and rebuilt, then inspected entry by entry for source/build equality. Final package names and checksums are recorded in PROGRESS.md.

Useful checks: node scripts/desktop-smoke.mjs, node scripts/packaged-engine-smoke.mjs, and node scripts/smoke.mjs against the disposable browser fixture. The optional FREEOCRAPI_TEST_PYTHON environment variable selects a Python executable for the client smoke check.

See PROGRESS.md for the remaining reference-parity work. This evidence does not assert full feature parity.
