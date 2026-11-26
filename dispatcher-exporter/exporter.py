#!/usr/bin/env python3
"""Prometheus metrics for Infinity snapshots and OpenClaw log counts (no log text)."""
import json
import os
import re
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SNAPSHOT = Path(os.getenv("DISPATCHER_SNAPSHOT_FILE", "/data/snapshot/snapshot.json"))
PORT = int(os.getenv("PORT", "9102"))
OPENCLAW_LOG_DIR = Path(os.getenv("OPENCLAW_LOG_DIR", "/data/openclaw-logs"))


def openclaw_metrics():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    count, recent_records = 0, 0
    out = ["# TYPE openclaw_log_read_error gauge"]
    try:
        # Include neighboring host dates to handle timezone offsets and numbered rotations.
        for path in sorted(OPENCLAW_LOG_DIR.iterdir()):
            match = re.fullmatch(r"openclaw-(\d{4}-\d{2}-\d{2})\.log(?:\.[1-5])?", path.name)
            if not match or not (str((cutoff - timedelta(days=1)).date()) <= match[1]
                                 <= str((now + timedelta(days=1)).date())):
                continue
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), encoding="utf-8") as handle:
                for line in handle:
                    # The gateway may still be writing the last JSONL record.
                    if not line.endswith("\n"):
                        break
                    if not line.strip():
                        continue
                    record = json.loads(line)
                    timestamp = datetime.fromisoformat(record["time"].replace("Z", "+00:00"))
                    level = record["_meta"]["logLevelName"]
                    if timestamp.tzinfo is None or level not in (
                            "SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"):
                        raise ValueError("invalid log metadata")
                    if cutoff < timestamp <= now:
                        recent_records += 1
                        count += level in ("ERROR", "FATAL")
        if not recent_records:
            raise ValueError("no recent readable log records")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        # Do not expose paths, messages or exceptions in metrics or server logs.
        return out + ["openclaw_log_read_error 1"]
    return out + ["openclaw_log_read_error 0",
                  "# TYPE openclaw_log_errors_24h gauge",
                  f"openclaw_log_errors_24h {count}"]


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
    out.extend(openclaw_metrics())
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
