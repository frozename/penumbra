import unittest

from trial_guard import assess_sample, classify_run, coexistence_status, validate_fixture_bytes, assert_port_available


class GuardTests(unittest.TestCase):
    def sample(self, **changes):
        row = dict(measuredAt=100, availableBytes=8 * 1024**3,
                   swapGrowthBytes=0, swapoutBytes=0, memoryFullAvg10=0,
                   maxTemperatureC=60, gufoHealthFailures=0, gufoPid=42)
        return row | changes

    def test_explicit_floor_override_admits_below_twenty_gib(self):
        self.assertIsNone(assess_sample(self.sample(), 101, 42))

    def test_emergency_reserve_is_distinct_from_admission_floor(self):
        self.assertEqual(assess_sample(self.sample(availableBytes=1024**3), 101, 42), 'memory_reserve')

    def test_missing_and_stale_measurements_fail_closed(self):
        self.assertEqual(assess_sample(self.sample(measuredAt=90), 101, 42), 'stale_sensor')
        self.assertEqual(assess_sample(self.sample(availableBytes=None), 101, 42), 'missing_memory')
        self.assertEqual(assess_sample(self.sample(swapGrowthBytes=float('nan')), 101, 42), 'missing_swap')

    def test_swap_growth_and_swapout_abort_independently(self):
        self.assertEqual(assess_sample(self.sample(swapGrowthBytes=257 * 1024**2), 101, 42), 'swap')
        self.assertEqual(assess_sample(self.sample(swapoutBytes=129 * 1024**2), 101, 42), 'swap')

    def test_pressure_and_thermal_abort(self):
        self.assertEqual(assess_sample(self.sample(memoryFullAvg10=6), 101, 42), 'memory_pressure')
        self.assertEqual(assess_sample(self.sample(maxTemperatureC=96), 101, 42), 'thermal')

    def test_production_restart_or_two_health_failures_abort_candidate(self):
        self.assertEqual(assess_sample(self.sample(gufoPid=43), 101, 42), 'gufo_pid_changed')
        self.assertEqual(assess_sample(self.sample(gufoHealthFailures=2), 101, 42), 'gufo_health')
        self.assertIsNone(assess_sample(self.sample(gufoHealthFailures=1), 101, 42))

    def test_no_exposure_does_not_pass(self):
        self.assertEqual(classify_run({'status': 'executed', 'rows': []}, {'status': 'stopped'}, 2), 'unexercised')

    def test_missing_or_aborted_guard_cannot_pass(self):
        run = {'status': 'executed', 'rows': [{'mode': 'shadow', 'applied': False, 'error': None}]}
        self.assertEqual(classify_run(run, None, 1), 'interrupted')
        self.assertEqual(classify_run(run, {'status': 'aborted'}, 1), 'aborted')

    def test_timeout_and_partial_coverage_do_not_pass(self):
        row = {'mode': 'shadow', 'applied': False, 'error': 'timeout'}
        self.assertEqual(classify_run({'status': 'executed', 'rows': [row]}, {'status': 'stopped'}, 1), 'partial_runtime_replay')
        row = row | {'error': None}
        self.assertEqual(classify_run({'status': 'executed', 'rows': [row]}, {'status': 'stopped'}, 2), 'partial_runtime_replay')

    def test_complete_shadow_runtime_is_not_a_quality_acceptance(self):
        row = {'mode': 'shadow', 'applied': False, 'error': None}
        self.assertEqual(classify_run({'status': 'executed', 'rows': [row]}, {'status': 'stopped'}, 1), 'completed_runtime_replay')

    def test_authority_change_is_invalid_even_if_answers_are_valid(self):
        row = {'mode': 'shadow', 'applied': True, 'error': None}
        self.assertEqual(classify_run({'status': 'executed', 'rows': [row]}, {'status': 'stopped'}, 1), 'invalid_authority')

    def test_missing_or_failed_gufo_probes_cannot_establish_coexistence(self):
        good = {'rows': [{'startedAt': 10, 'endedAt': 11, 'ttftMs': 20, 'error': None}]}
        self.assertEqual(coexistence_status([good, good, None], [(10, 12)])[0], 'incomplete')
        bad = {'rows': [good['rows'][0] | {'error': 'TimeoutError'}]}
        self.assertEqual(coexistence_status([good, bad, good], [(10, 12)])[0], 'probe_errors')

    def test_coexistence_requires_actual_successful_request_overlap(self):
        good = {'rows': [{'index': 0, 'startedAt': 10, 'endedAt': 11, 'ttftMs': 20, 'error': None}]}
        self.assertEqual(coexistence_status([good]*3, [(12, 13)]), ('unexercised', []))
        self.assertEqual(coexistence_status([good]*3, [(10.5, 12)]), ('observed_overlap_not_acceptance', [0]))

    def test_fixture_subset_cannot_be_reported_as_full_corpus(self):
        import hashlib
        raw = b'{"id":"one"}\n'
        sha = hashlib.sha256(raw).hexdigest()
        self.assertEqual(validate_fixture_bytes(raw, 1, sha)['rows'], 1)
        with self.assertRaises(ValueError):
            validate_fixture_bytes(raw, 320, sha)
        with self.assertRaises(ValueError):
            validate_fixture_bytes(raw, 1, '0'*64)

    def test_port_probe_rejects_live_listener_but_allows_released_port(self):
        import socket
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.listen()
            with self.assertRaises(OSError):
                assert_port_available(port)
        assert_port_available(port)


if __name__ == '__main__':
    unittest.main()
