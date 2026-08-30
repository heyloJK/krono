#!/usr/bin/env python3
"""Tiny static server for local dev. Serves this file's directory.

    python3 serve.py            # http://localhost:8777
    PORT=9000 python3 serve.py  # custom port

Uses an explicit directory (no chdir) so it works from any working directory.
"""
import os
import http.server
import socketserver

PORT = int(os.environ.get("PORT", "8777"))
DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)

    def end_headers(self):
        # Dev server: never cache, so edits show up on reload.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Chrono serving {DIR} at http://localhost:{PORT}", flush=True)
    httpd.serve_forever()
