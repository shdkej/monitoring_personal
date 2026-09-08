#!/usr/bin/env python3
"""Prometheus exporter for a sanitized Infinity dispatcher snapshot."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SNAPSHOT = Path(os.getenv("DISPATCHER_SNAPSHOT_FILE", "/data/snapshot/snapshot.json"))
PORT = int(os.getenv("PORT", "9102"))


def number(data, key):
    value = data.get(key, 0)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def render():
    try:
        data = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or number(data, "last_run_timestamp_seconds") <= 0:
            raise ValueError("incomplete snapshot")
        error = 0
    except (OSError, ValueError, json.JSONDecodeError):
        data, error = {}, 1
    out = [
        "# TYPE infinity_dispatcher_snapshot_read_error gauge",
        f"infinity_dispatcher_snapshot_read_error {error}",
        "# TYPE infinity_dispatcher_last_run_timestamp_seconds gauge",
        f"infinity_dispatcher_last_run_timestamp_seconds {number(data, 'last_run_timestamp_seconds')}",
        "# TYPE infinity_dispatcher_run_ok gauge",
        f"infinity_dispatcher_run_ok {number(data, 'run_ok')}",
        "# TYPE infinity_dispatcher_invalid_state_total gauge",
        f"infinity_dispatcher_invalid_state_total {number(data, 'invalid_state_total')}",
        "# TYPE infinity_dispatcher_delivery_uncertain gauge",
        f"infinity_dispatcher_delivery_uncertain {number(data, 'delivery_uncertain')}",
        "# TYPE infinity_dispatcher_active_without_evidence gauge",
        f"infinity_dispatcher_active_without_evidence {number(data, 'active_without_evidence')}",
    ]
    for state in ("inbox", "active", "waiting", "archive"):
        out.append(f'infinity_dispatcher_intents{{state="{state}"}} {number(data, state)}')
    return "\n".join(out) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_error(404)
            return
        body = render().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
