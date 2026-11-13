"""Rollback takes priority over auxiliary telemetry cleanup."""
import subprocess


def finalize(restore, sampler):
    try:
        restore()
    finally:
        if sampler is not None:
            try:
                sampler.terminate()
                sampler.wait(timeout=3)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                sampler.kill()
                try:
                    sampler.wait(timeout=1)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
