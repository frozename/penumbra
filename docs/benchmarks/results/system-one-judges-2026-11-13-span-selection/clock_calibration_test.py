import importlib.util
from pathlib import Path
import unittest

from clock_calibration import estimate_offset

path = Path(__file__).resolve().parent.parent / 'system-one-judges-2026-11-12-z13-npu-test/trial_guard.py'
spec = importlib.util.spec_from_file_location('existing_guard', path)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ClockCalibrationTests(unittest.TestCase):
    def row(self, measured):
        return dict(measuredAt=measured, availableBytes=21*1024**3, swapGrowthBytes=0, swapoutBytes=0, memoryFullAvg10=0, gufoPid=7, gufoHealthFailures=0)

    def test_clock_offset_accepts_fresh_remote_sensor_without_weakening_age_limit(self):
        offset, uncertainty = estimate_offset(100, 100.02, 102.01)
        self.assertEqual(guard.assess_sample(self.row(102.1), 100.2, 7), 'stale_sensor')
        self.assertIsNone(guard.assess_sample(self.row(102.1), 100.2+offset+uncertainty, 7))

    def test_old_data_stays_stale_after_clock_calibration(self):
        offset, uncertainty = estimate_offset(100,100.02,102.01)
        self.assertEqual(guard.assess_sample(self.row(92),100.2+offset+uncertainty,7),'stale_sensor')

    def test_unbounded_or_missing_clock_evidence_is_rejected(self):
        for values in [(100,102,102), (100,99,102), (100,100.1,float('nan'))]:
            with self.assertRaises(ValueError): estimate_offset(*values)


if __name__ == '__main__':
    unittest.main()
