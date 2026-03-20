#!/usr/bin/env python3
"""Simple HTTP server with CORS headers for Figma plugin development."""
import http.server
import sys

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f"Serving on http://localhost:{port} with CORS enabled")
http.server.HTTPServer(('', port), CORSHandler).serve_forever()
