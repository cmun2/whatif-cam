#!/usr/bin/env python3
"""
A static file server for the repo root, with two headers that matter.

Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy are what let the browser hand
ONNX Runtime a SharedArrayBuffer, which is what lets its WASM build use more than one
thread. ARCHITECTURE.md flags this as an architectural decision rather than a deployment
detail, because GitHub Pages cannot set these headers and every non-WebGPU visitor there
falls back to single-threaded WASM.

Everything is same-origin, so require-corp costs nothing here.

    python3 app/serve.py [port]
"""
import http.server, os, socketserver, sys, webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8017


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args) or "500" in (fmt % args):
            sys.stderr.write("  %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    url = f"http://localhost:{PORT}/app/"
    print(f"WhatIf Cam v0.0  ->  {url}")
    print("   serving", ROOT)
    print("   ctrl-c to stop")
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
