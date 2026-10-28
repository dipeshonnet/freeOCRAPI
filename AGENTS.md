# FreeOCRapi implementation instructions

Read `PROGRESS.md` and `IMPLEMENTATION_PLAN.md` before changing code. Continue the first unfinished step. Work sequentially: finish and verify one step before starting another. After each step update PROGRESS.md with exact checks, limitations, and the next action. Never report an unverified capability as complete.

Reference: ../Freellmapi, commit 2359d30bc2d72347dcea4276ada38ebef204d7ca. Reuse its MIT-licensed design and applicable infrastructure. Never copy .env, runtime databases, personal configuration, or credentials. Do not modify that checkout.

Product: local-first OCR gateway, web + Electron desktop + CLI + Docker. One engine per document with sequential failover; no ensemble or merged transcripts. Built-in Tesseract; optional PaddleOCR/Docling services; LlamaParse, Mistral, OCR.space, Azure, Google Document AI, Textract, custom adapters. Preserve truthful capability/health reporting and unknown usage/confidence values.

Do not add cloud publication, subscriptions, or upstream FreeLLMAPI catalog/update calls. Optional limits follow the reference: 0 means unlimited. Keep provider credentials encrypted. No real provider credentials in fixtures or outputs.
