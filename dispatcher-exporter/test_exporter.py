import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

M = Path(__file__).with_name("exporter.py")


class ExporterTest(unittest.TestCase):
    def module(self, snapshot):
        spec = importlib.util.spec_from_file_location("exporter_test", M)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.SNAPSHOT = snapshot
        return module

    def test_renders_sanitized_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "snapshot.json"
            path.write_text(json.dumps({"last_run_timestamp_seconds": 1, "run_ok": 1, "active": 2, "waiting": 1}))
            output = self.module(path).render()
            self.assertIn("snapshot_read_error 0", output)
            self.assertIn('intents{state="active"} 2', output)
            self.assertNotIn("intent_id", output)

    def test_missing_snapshot_is_explicit_error(self):
        output = self.module(Path("/nonexistent/snapshot.json")).render()
        self.assertIn("snapshot_read_error 1", output)
        self.assertIn("last_run_timestamp_seconds 0", output)

    def log_output(self, files):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            now = datetime.now(timezone.utc)
            for suffix, records in files.items():
                content = records if isinstance(records, str) else "".join(
                    json.dumps({"time": (now + timedelta(hours=hours)).isoformat(),
                                "_meta": {"logLevelName": level},
                                "message": "private message error"}) + "\n"
                    for hours, level in records)
                (directory / f"openclaw-{now:%Y-%m-%d}.log{suffix}").write_text(content)
            module = self.module(directory / "snapshot.json")
            module.OPENCLAW_LOG_DIR = directory
            return module.render()

    def test_counts_error_and_fatal_in_last_24_hours_including_rotations(self):
        output = self.log_output({"": [(-1, "ERROR"), (-1, "WARN"), (-1, "INFO"),
                                      (-25, "ERROR"), (1, "ERROR")],
                                  ".1": [(-2, "FATAL")]})
        self.assertIn("openclaw_log_errors_24h 2\n", output)
        self.assertIn("openclaw_log_read_error 0\n", output)
        self.assertNotIn("private message", output)

    def test_valid_logs_without_errors_emit_zero(self):
        self.assertIn("openclaw_log_errors_24h 0\n", self.log_output({"": [(-1, "INFO")]}))

    def test_unavailable_or_corrupt_logs_do_not_emit_false_zero(self):
        for files in ({}, {"": "broken JSON\n"}, {"": "{}\n"}, {"": ""}):
            with self.subTest(files=files):
                output = self.log_output(files)
                self.assertIn("openclaw_log_read_error 1\n", output)
                self.assertNotIn("openclaw_log_errors_24h ", output)

    def test_incomplete_final_line_is_ignored_until_finished(self):
        now = datetime.now(timezone.utc).isoformat()
        line = json.dumps({"time": now, "_meta": {"logLevelName": "ERROR"}})
        output = self.log_output({"": line + "\n" + '{"time":'})
        self.assertIn("openclaw_log_errors_24h 1\n", output)

    def test_error_details_are_recent_sorted_bounded_and_redacted(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            now = datetime.now(timezone.utc)
            records = [{"time": (now - timedelta(minutes=i)).isoformat(),
                        "_meta": {"logLevelName": "ERROR"},
                        "message": 'Authorization: Bearer private-token\nemail=user@example.com password="super secret" sessionKey=private-session-key chatId=private-chat-id',
                        "session_id": "do-not-export"} for i in range(60)]
            records.append({"time": (now - timedelta(hours=25)).isoformat(),
                            "_meta": {"logLevelName": "ERROR"}, "message": "old"})
            (directory / f"openclaw-{now:%Y-%m-%d}.log").write_text(
                "".join(json.dumps(r) + "\n" for r in reversed(records)))
            module = self.module(directory / "snapshot.json")
            module.OPENCLAW_LOG_DIR = directory
            self.assertTrue(hasattr(module, "openclaw_details"), "error detail endpoint is missing")
            result = module.openclaw_details()
            self.assertEqual(result["total"], 60)
            self.assertEqual(len(result["errors"]), 50)
            self.assertGreaterEqual(result["errors"][0]["time"], result["errors"][-1]["time"])
            encoded = json.dumps(result)
            for secret in ("private-token", "user@example.com", "super secret", "do-not-export", "private-session-key", "private-chat-id"):
                self.assertNotIn(secret, encoded)
            self.assertIn("[REDACTED]", encoded)

    def test_detail_read_failure_is_not_empty_success(self):
        module = self.module(Path("/nonexistent/snapshot.json"))
        module.OPENCLAW_LOG_DIR = Path("/nonexistent/openclaw")
        self.assertTrue(hasattr(module, "openclaw_details"), "error detail endpoint is missing")
        with self.assertRaises(OSError):
            module.openclaw_details()


if __name__ == "__main__":
    unittest.main()
