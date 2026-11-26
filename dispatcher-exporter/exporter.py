#!/usr/bin/env python3
"""Prometheus metrics and a private, redacted OpenClaw error detail endpoint."""
import json
import os
import re
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SNAPSHOT = Path(os.getenv("DISPATCHER_SNAPSHOT_FILE", "/data/snapshot/snapshot.json"))
PORT = int(os.getenv("PORT", "9102"))
OPENCLAW_LOG_DIR = Path(os.getenv("OPENCLAW_LOG_DIR", "/data/openclaw-logs"))


def redact_message(message):
    text = str(message)
    text = re.sub(r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text)
    text = re.sub(r"(?i)((?:password|passwd|token|api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|authorization|cookie|session[_-]?id)[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)", r"\1[REDACTED]", text)
    text = re.sub(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk-|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{10,}", "[REDACTED]", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[REDACTED]", text)
    text = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[REDACTED]@", text)
    text = re.sub(r"\b[0-9]{10,16}\b", "[REDACTED]", text)
    text = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x08\x0b-\x1f\x7f]", "", text)
    return text[:2000]


def recent_openclaw_records():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    recent_records = 0
    for path in sorted(OPENCLAW_LOG_DIR.iterdir()):
        match = re.fullmatch(r"openclaw-(\d{4}-\d{2}-\d{2})\.log(?:\.[1-5])?", path.name)
        if not match or not (str((cutoff - timedelta(days=1)).date()) <= match[1]
                             <= str((now + timedelta(days=1)).date())):
            continue
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), encoding="utf-8") as handle:
            for line in handle:
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
                    yield timestamp, level, record
    if not recent_records:
        raise ValueError("no recent readable log records")


def openclaw_details():
    count, errors = 0, []
    for timestamp, level, record in recent_openclaw_records():
        if level in ("ERROR", "FATAL"):
            count += 1
            errors.append({"time": timestamp.astimezone(timezone.utc).isoformat(),
                           "level": level,
                           "message": redact_message(record.get("message", record.get("0", "(메시지 없음)")))})
            errors.sort(key=lambda row: row["time"], reverse=True)
            del errors[50:]
    return {"total": count, "errors": errors}


def openclaw_metrics():
    out = ["# TYPE openclaw_log_read_error gauge"]
    try:
        count = sum(level in ("ERROR", "FATAL") for _, level, _ in recent_openclaw_records())
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
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
        status, content_type = 200, "text/plain; version=0.0.4"
        if self.path == "/metrics":
            body = render().encode()
        elif self.path == "/healthz":
            body = b"ok\n"
        elif self.path == "/openclaw/errors":
            content_type = "application/json; charset=utf-8"
            try:
                body = json.dumps(openclaw_details(), ensure_ascii=False).encode()
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                status, body = 503, b'{"error":"OpenClaw log source unavailable"}'
        else:
            self.send_error(404)
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
