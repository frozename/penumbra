import unittest
from guard import assess_guard, observer_status
G=1024**3
class GuardTests(unittest.TestCase):
 def state(self,**changes):
  row={'criticalMeasuredAt':100.0,'availableFreeInactiveBytes':6*G,'healthStatus':200,'consecutiveHealthFailures':0,'swapGrowthBytes':0,'swapoutBytes':0}
  row.update(changes);return row
 def test_fresh_critical_snapshot_does_not_inherit_slow_gpu_timestamp(self):
  self.assertEqual(assess_guard(self.state(ts=90),101,'live'),('admit',None))
 def test_stale_critical_data_fails_closed(self):
  self.assertEqual(assess_guard(self.state(),103,'live'),('abort','stale_critical_sensor'))
 def test_missing_memory_fails_closed(self):
  self.assertEqual(assess_guard(self.state(availableFreeInactiveBytes=None),101,'live'),('abort','missing_memory'))
 def test_low_memory_waits_without_admitting(self):
  self.assertEqual(assess_guard(self.state(availableFreeInactiveBytes=4*G),101,'live'),('wait','memory_admission'))
 def test_reserve_breach_aborts(self):
  self.assertEqual(assess_guard(self.state(availableFreeInactiveBytes=G),101,'live'),('abort','memory_reserve'))
 def test_one_failed_health_probe_blocks_admission(self):
  self.assertEqual(assess_guard(self.state(healthStatus=None,consecutiveHealthFailures=1),101,'live'),('wait','health'))
 def test_two_failed_probes_abort(self):
  self.assertEqual(assess_guard(self.state(healthStatus=None,consecutiveHealthFailures=2),101,'live'),('abort','health'))
 def test_baseline_health_failure_aborts(self):
  self.assertEqual(assess_guard(self.state(healthStatus=None,consecutiveHealthFailures=1),101,'baseline'),('abort','baseline_health'))
 def test_swap_bound_aborts(self):
  self.assertEqual(assess_guard(self.state(swapGrowthBytes=257*1024**2),101,'live'),('abort','swap'))
 def test_observer_error_cannot_pass_even_with_zero_exit_code(self):
  self.assertEqual(observer_status(0,{'endedBy':'Error: stale_or_failed_guard','attempted':0}), 'interrupted')
 def test_zero_exposure_is_unexercised(self):
  self.assertEqual(observer_status(0,{'endedBy':'duration','attempted':0}), 'unexercised')
 def test_partial_exposure_is_not_complete(self):
  self.assertEqual(observer_status(0,{'endedBy':'guard_or_operator_stop','attempted':9}), 'interrupted')
 def test_exhausted_replay_is_runtime_evidence_only(self):
  self.assertEqual(observer_status(0,{'endedBy':'inputs_exhausted','attempted':20}), 'completed_runtime_replay')
if __name__=='__main__':unittest.main()
