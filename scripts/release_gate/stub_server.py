#!/usr/bin/env python3
"""A stand-in for the testnet that answers but has nothing (ENG-18798). Stdlib only.

The smoke script (smoke.sh, or smoke.mjs in a JavaScript SDK) points the just-built smoke at it to prove "failed" (exit 1) stays apart from "testnet
unreachable" (exit 2) and from a pass. With no argument, every GET or POST, on any path, gets
HTTP 200 with the JSON body `[]`, which holds no market: the smoke must exit 1. With a status code
(`stub_server.py 503`), every request gets that status and a small JSON error body: for 503 the
smoke must exit 2, as it would for a testnet outage. It listens on 127.0.0.1 on a free port, prints
that port as its first line of stdout, and serves until it is killed.

Run: python3 scripts/release_gate/stub_server.py [STATUS]
"""

import http.server
import sys

STATUS = 200
BODY = b"[]"


class Empty(http.server.BaseHTTPRequestHandler):
    def answer(self):
        self.send_response(STATUS)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    do_GET = answer
    do_POST = answer

    def log_message(self, *args):
        pass  # the smoke's own output is what the job log is for


def main():
    global STATUS, BODY
    if len(sys.argv) > 1:
        STATUS = int(sys.argv[1])
        BODY = b'{"error": "stub_server.py answers %d to everything"}' % STATUS
    # Threading, so a client that holds one connection open can't wedge the next request.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Empty)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
