"""FreeOCRapi readers. Core HTTP client uses only the Python standard library."""
from __future__ import annotations
import json
import mimetypes
import os
import time
import uuid
from pathlib import Path
from urllib.request import Request, HTTPRedirectHandler, build_opener
from urllib.error import HTTPError


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # urllib otherwise copies the bearer header across origins.
        return None


class FreeOCRClient:
    def __init__(self, base_url=None, api_key=None, engine="auto", timeout=1800):
        self.base_url = (base_url or os.environ.get("FREEOCRAPI_URL", "http://127.0.0.1:3002")).rstrip("/")
        self.api_key = api_key or os.environ.get("FREEOCRAPI_API_KEY", "")
        self.engine = engine
        self.timeout = timeout

    def _request(self, route, body=None, content_type="application/json"):
        headers = {"Authorization": "Bearer " + self.api_key}
        if body is not None:
            headers["Content-Type"] = content_type
        request = Request(self.base_url + route, data=body, headers=headers)
        try:
            with build_opener(_NoRedirect()).open(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                if 300 <= error.code < 400:
                    message = "Gateway redirects are disabled. Configure the final gateway URL."
                else:
                    try:
                        message = json.load(error).get("error", {}).get("message", str(error))
                    except (ValueError, AttributeError):
                        message = str(error)
            finally:
                error.close()
            raise RuntimeError(message) from None

    def extract(self, filename, options=None):
        file = Path(filename)
        if file.suffix.lower() not in (".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"):
            raise ValueError("Choose a PDF, PNG, JPEG, WebP or TIFF document.")
        boundary = "freeocrapi-" + uuid.uuid4().hex
        # A fixed multipart filename prevents caller filenames from injecting headers.
        content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"document{file.suffix}\"\r\nContent-Type: {content_type}\r\n\r\n").encode() + file.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        uploaded = self._request("/v1/files", body, "multipart/form-data; boundary=" + boundary)
        job = self._request("/v1/ocr", json.dumps({"fileId": uploaded["id"], "engine": self.engine, "options": options or {}}).encode())
        return self.wait(job["id"])

    def wait(self, job_id):
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            job = self._request("/v1/jobs/" + job_id)
            if job["status"] == "succeeded":
                return job["result"]
            if job["status"] not in ("queued", "running"):
                raise RuntimeError(f"{job['status']}: {job.get('error')}. Job ID: {job_id}")
            time.sleep(1)
        raise TimeoutError(f"OCR is still processing. Resume with client.wait({job_id!r}).")

class FreeOCRReader(FreeOCRClient):
    def load_data(self, file_path, **options):
        from llama_index.core import Document
        result = self.extract(file_path, options or None)
        return [Document(text=page["text"], metadata={"source": str(file_path), "page": page["number"], "engine": result["engine"]}) for page in result["pages"]]

class FreeOCRLoader:
    def __init__(self, file_path, **client_options):
        self.file_path = file_path
        self.client = FreeOCRClient(**client_options)

    def load(self):
        from langchain_core.documents import Document
        result = self.client.extract(self.file_path)
        return [Document(page_content=page["text"], metadata={"source": str(self.file_path), "page": page["number"], "engine": result["engine"]}) for page in result["pages"]]

class FreeOCRConverter(FreeOCRClient):
    def run(self, sources):
        from haystack import Document
        documents = []
        for source in sources:
            result = self.extract(source)
            documents.extend(Document(content=page["text"], meta={"source": str(source), "page": page["number"], "engine": result["engine"]}) for page in result["pages"])
        return {"documents": documents}

# Haystack's decorators are optional: importing the core client requires no framework.
try:
    from haystack import component, Document as HaystackDocument
except ImportError:
    pass
else:
    FreeOCRConverter.run = component.output_types(documents=list[HaystackDocument])(FreeOCRConverter.run)
    FreeOCRConverter = component(FreeOCRConverter)
