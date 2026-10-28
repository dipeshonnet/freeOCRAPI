"""Local HTTP regression checks; no provider accounts or external traffic."""
import json
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from integrations.python.freeocrapi import FreeOCRClient


@contextmanager
def server(handler):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            handler(self)

        def do_POST(self):
            handler(self)

        def log_message(self, *_):
            pass

    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{instance.server_port}"
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join()


def respond(request, value):
    data = json.dumps(value).encode()
    request.send_response(200)
    request.send_header("Content-Type", "application/json")
    request.send_header("Content-Length", str(len(data)))
    request.end_headers()
    request.wfile.write(data)


class ClientSecurityTests(unittest.TestCase):
    def test_redirects_never_forward_the_processing_key(self):
        received = []

        def destination(request):
            received.append(request.headers.get("Authorization"))
            respond(request, {"redirected": True})

        with server(destination) as target:
            for status in (301, 302, 303, 307, 308):
                with self.subTest(status=status):
                    def redirect(request):
                        request.send_response(status)
                        request.send_header("Location", target + "/received")
                        request.end_headers()

                    with server(redirect) as gateway:
                        client = FreeOCRClient(gateway, "fixture-processing-key")
                        with self.assertRaises(RuntimeError):
                            client._request("/v1/jobs")
                    self.assertEqual(received, [])

    def test_direct_authenticated_get_and_post_still_work(self):
        received = []

        def gateway(request):
            body = request.rfile.read(int(request.headers.get("Content-Length", 0)))
            received.append((request.headers.get("Authorization"), body))
            respond(request, {"ok": True})

        with server(gateway) as base:
            client = FreeOCRClient(base, "fixture-processing-key")
            self.assertEqual(client._request("/v1/jobs"), {"ok": True})
            self.assertEqual(client._request("/v1/ocr", b'{"fileId":"fixture"}'), {"ok": True})
        self.assertEqual(received, [
            ("Bearer fixture-processing-key", b""),
            ("Bearer fixture-processing-key", b'{"fileId":"fixture"}'),
        ])


if __name__ == "__main__":
    unittest.main()
