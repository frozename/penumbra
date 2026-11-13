import math
import hashlib
import json
import socket

GIB = 1024**3


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def assess_sample(row, now, gufo_pid):
    measured = row.get('measuredAt')
    if not finite(measured) or not -1 <= now - measured <= 3.5:
        return 'stale_sensor'
    if not finite(row.get('availableBytes')):
        return 'missing_memory'
    if row['availableBytes'] < 2 * GIB:
        return 'memory_reserve'
    if not all(finite(row.get(k)) for k in ['swapGrowthBytes', 'swapoutBytes']):
        return 'missing_swap'
    if row['swapGrowthBytes'] > 256 * 1024**2 or row['swapoutBytes'] > 128 * 1024**2:
        return 'swap'
    if not finite(row.get('memoryFullAvg10')):
        return 'missing_pressure'
    if row['memoryFullAvg10'] > 5:
        return 'memory_pressure'
    if finite(row.get('maxTemperatureC')) and row['maxTemperatureC'] >= 95:
        return 'thermal'
    if row.get('gufoPid') != gufo_pid:
        return 'gufo_pid_changed'
    if row.get('gufoHealthFailures', 0) >= 2:
        return 'gufo_health'
    return None


def classify_run(run, guard, expected):
    if not guard or guard.get('status') not in ['stopped', 'aborted']:
        return 'interrupted'
    if guard['status'] == 'aborted':
        return 'aborted'
    if not run or run.get('status') != 'executed':
        return 'not_run'
    rows = run.get('rows', [])
    if not rows:
        return 'unexercised'
    if any(r.get('mode') != 'shadow' or r.get('applied') is not False for r in rows):
        return 'invalid_authority'
    if len(rows) != expected or any(r.get('error') is not None for r in rows):
        return 'partial_runtime_replay'
    return 'completed_runtime_replay'


def coexistence_status(phases, candidate_intervals):
    if len(phases) != 3 or any(not phase or not phase.get('rows') for phase in phases):
        return 'incomplete', []
    if any(row.get('error') or row.get('ttftMs') is None for phase in phases for row in phase['rows']):
        return 'probe_errors', []
    overlapping = [row['index'] for row in phases[1]['rows']
                   if any(row['startedAt'] < end and row['endedAt'] > start
                          for start, end in candidate_intervals)]
    return ('observed_overlap_not_acceptance' if overlapping else 'unexercised'), overlapping


def validate_fixture_bytes(raw, expected_count, expected_sha):
    rows = [json.loads(line) for line in raw.splitlines() if line]
    digest = hashlib.sha256(raw).hexdigest()
    if len(rows) != expected_count or digest != expected_sha:
        raise ValueError('Fixture count/hash mismatch; refuse mislabeled or changed corpus')
    return dict(rows=len(rows), rawSha256=digest)


def assert_port_available(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))
