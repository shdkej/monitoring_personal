import importlib.util
import json
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
