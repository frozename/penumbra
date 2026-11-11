import subprocess
import unittest

from trial_cleanup import finalize


class CleanupTest(unittest.TestCase):
    def test_restore_precedes_sampler_timeout_and_force_stop(self):
        calls = []

        class Sampler:
            def terminate(self):
                calls.append("terminate")

            def wait(self, timeout):
                calls.append(("wait", timeout))
                raise subprocess.TimeoutExpired("sampler", timeout)

            def kill(self):
                calls.append("kill")

        finalize(lambda: calls.append("restore"), Sampler())
        self.assertEqual(calls, ["restore", "terminate", ("wait", 3), "kill", ("wait", 1)])

    def test_missing_sampler_does_not_skip_restore(self):
        calls = []
        finalize(lambda: calls.append("restore"), None)
        self.assertEqual(calls, ["restore"])

    def test_restore_failure_is_preserved_after_sampler_cleanup(self):
        calls = []

        class Sampler:
            def terminate(self):
                calls.append("terminate")

            def wait(self, timeout):
                calls.append("wait")

        def restore():
            raise RuntimeError("restore failed")

        with self.assertRaisesRegex(RuntimeError, "restore failed"):
            finalize(restore, Sampler())
        self.assertEqual(calls, ["terminate", "wait"])
