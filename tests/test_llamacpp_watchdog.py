import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


WATCHDOG_PATH = Path(__file__).resolve().parents[1] / "llamacpp_watchdog.py"


def load_watchdog():
    spec = importlib.util.spec_from_file_location("prompt_studio_llamacpp_watchdog", WATCHDOG_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LlamacppWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.watchdog = load_watchdog()
        self.temp = tempfile.TemporaryDirectory()
        self.state_path = Path(self.temp.name) / "process.json"
        self.token = "a" * 32
        self.owner_identity = {
            "executable": "/runtime/python",
            "creation_marker": "proc:owner",
        }
        self.target_identity = {
            "executable": "/runtime/llama-server",
            "creation_marker": "proc:target",
        }
        self.state = {
            "version": 2,
            "pid": 222,
            "identity": self.target_identity,
            "details": {},
            "watchdog": {
                "token": self.token,
                "owner_pid": 111,
                "owner_identity": self.owner_identity,
                "grace_seconds": 0,
            },
        }
        self.state_path.write_text(json.dumps(self.state), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_owner_exit_stops_only_the_recorded_llamacpp_process(self):
        def snapshot(pid):
            return self.target_identity if pid == 222 else None

        with (
            mock.patch.object(self.watchdog, "_process_snapshot", side_effect=snapshot),
            mock.patch.object(self.watchdog, "_terminate_process") as terminate,
        ):
            self.watchdog.run_watchdog(str(self.state_path), self.token)

        terminate.assert_called_once_with(222, self.target_identity)
        self.assertTrue(self.state_path.exists())

    def test_new_ownership_token_cancels_pending_shutdown(self):
        reads = iter((self.state, None))

        with (
            mock.patch.object(self.watchdog, "_read_owned_state", side_effect=lambda *_: next(reads)),
            mock.patch.object(self.watchdog, "_process_snapshot", return_value=None),
            mock.patch.object(self.watchdog, "_terminate_process") as terminate,
        ):
            self.watchdog.run_watchdog(str(self.state_path), self.token)

        terminate.assert_not_called()

    def test_reused_target_pid_is_not_terminated(self):
        reused = {
            "executable": self.target_identity["executable"],
            "creation_marker": "proc:replacement",
        }
        with (
            mock.patch.object(self.watchdog, "_process_snapshot", return_value=reused),
            mock.patch.object(self.watchdog.os, "kill") as kill,
        ):
            self.watchdog._terminate_process(222, self.target_identity)

        kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
