#!/usr/bin/env python3
"""HTTP server with CORS and POST support for DS Assembler plugin."""
import http.server
import json
import os
import sys

DATA_DIR = os.path.dirname(os.path.abspath(__file__))

class AssemblerHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        file_map = {
            '/analysis': 'analysis.json',
            '/update-result': 'update-result.json',
        }
        filename = file_map.get(self.path)
        if not filename:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'Unknown endpoint')
            return
        filepath = os.path.join(DATA_DIR, filename)
        try:
            data = json.loads(body)
            with open(filepath, 'w') as f:
                json.dump(data, f, indent=2)
            print(f"[POST] Saved {self.path} -> {filepath} ({len(body)} bytes)")
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "file": filename}).encode())
        except json.JSONDecodeError as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(f"Invalid JSON: {e}".encode())

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f"DS Assembler server on http://localhost:{port}")
print(f"  GET  /registry/...     -> component registry")
print(f"  GET  /spec.json        -> layout spec")
print(f"  POST /analysis         -> save analysis results")
print(f"  GET  /updates.json     -> update instructions")
print(f"  POST /update-result    -> save update results")
http.server.HTTPServer(('', port), AssemblerHandler).serve_forever()
