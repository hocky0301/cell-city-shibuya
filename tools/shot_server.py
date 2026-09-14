#!/usr/bin/env python3
"""撮影用: ページからPOSTされたdataURLをshots/に保存する"""
import base64, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = os.path.join(os.path.dirname(__file__), "..", "shots")

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        name = self.path.strip("/").replace("..", "_") or "shot"
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode()
        b64 = body.split(",", 1)[1] if "," in body else body
        path = os.path.join(OUT, name + ".jpg")
        open(path, "wb").write(base64.b64decode(b64))
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"ok")
        print("saved", path, flush=True)
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 8124), H).serve_forever()
