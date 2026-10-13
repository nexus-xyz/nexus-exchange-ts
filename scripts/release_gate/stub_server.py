#!/usr/bin/env python3
"""A stand-in for the testnet that answers but has nothing (ENG-18798). Stdlib only.

smoke.sh points the just-built smoke at it to prove "failed" (exit 1) stays apart from "testnet
unreachable" (exit 2) and from a pass: every GET or POST, on any path, gets HTTP 200 with the JSON
body `[]`, which holds no market. It listens on 127.0.0.1 on a free port, prints that port as its
first line of stdout, and serves until it is killed.

Run: python3 scripts/release_gate/stub_server.py
"""

import http.server
import sys

BODY = b"[]"


class Empty(http.server.BaseHTTPRequestHandler):
    def answer(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    do_GET = answer
    do_POST = answer

    def log_message(self, *args):
        pass  # the smoke's own output is what the job log is for


def main():
    server = http.server.HTTPServer(("127.0.0.1", 0), Empty)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
