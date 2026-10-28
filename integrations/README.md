# Integrations

Run Python examples from the repository root (or add it to `PYTHONPATH`). Set `FREEOCRAPI_URL` and `FREEOCRAPI_API_KEY` in the environment; the default URL is `http://127.0.0.1:3002`. The CLI and Python client reject gateway redirects to avoid forwarding credentials or documents; configure the final gateway URL directly. The core Python client needs no third-party dependencies. Framework wrappers require your existing `llama-index-core`, `langchain-core` or `haystack-ai` installation.

```python
from integrations.python.freeocrapi import FreeOCRReader
documents = FreeOCRReader().load_data("document.pdf")
```

Use `FreeOCRLoader("document.pdf").load()` for LangChain or `FreeOCRConverter().run(sources=["document.pdf"])` for Haystack. Metadata preserves source filename, page number and serving engine. The core `FreeOCRClient.extract()` returns normalized JSON; `wait(job_id)` resumes a known job without uploading again.

REST and interactive OpenAPI docs are at `/v1/docs`. Upload a file with `POST /v1/files`, pass its `id` as `fileId` to `POST /v1/ocr`, then poll the returned job's Location. Public HTTP(S) URLs are accepted in place of `fileId`; private network URLs are rejected.

The stateless MCP endpoint is `/mcp`, authenticated with the same unified bearer key. Tools are `list_engines`, `extract_document`, `get_job`, `cancel_job` and `get_usage`. This gateway performs OCR and returns documents; indexing, retrieval and question answering remain in your framework.

The CLI is currently a local script: `node cli/index.mjs --help`. It is not an npm-published package. Its last submitted job IDs are saved to `data/cli/last-jobs.json`; use `node cli/index.mjs jobs JOB_ID --wait` to resume waiting after interruption. Credentials are never saved there.
