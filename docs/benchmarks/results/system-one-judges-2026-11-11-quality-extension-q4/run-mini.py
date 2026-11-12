"""One-run quality extension; explicit live inference, guarded pause/restore of Granite."""
import importlib.util
import json
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
PREVIOUS = ROOT.parent / 'system-one-judges-2026-11-11-production-readiness'
PRIVATE = Path('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111')
spec = importlib.util.spec_from_file_location('previous_driver', PREVIOUS / 'continue-model-bench.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.ROOT = ROOT
m.LOGS = PRIVATE / 'quality-extension-q4'
m.LOGS.mkdir(mode=0o700, exist_ok=True)
m.EVENTS = []
m.SAMPLERS = []
m.ACTIVE = None
INTERRUPTING = False


def interrupt(signum, frame):
    global INTERRUPTING
    if not INTERRUPTING:
        INTERRUPTING = True
        raise KeyboardInterrupt(signum)


for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
    signal.signal(sig, interrupt)


def memory():
    vm = subprocess.check_output(['vm_stat'], text=True)
    page = int(re.search(r'page size of (\d+)', vm)[1])
    counts = {key: int(re.search(re.escape(key) + r':\s+(\d+)', vm)[1])
              for key in ['Pages free', 'Pages inactive', 'Swapouts']}
    swap = subprocess.check_output(['sysctl', 'vm.swapusage'], text=True)
    return {'availableFreeInactiveBytes': (counts['Pages free'] + counts['Pages inactive']) * page,
            'swapUsedBytes': float(re.search(r'used = ([\d.]+)M', swap)[1]) * 1024**2,
            'swapoutBytes': counts['Swapouts'] * page,
            'osMemoryPressure': subprocess.check_output(['memory_pressure', '-Q'], text=True).strip()}


def bench(name, fixtures, baseline):
    args = ['bun', 'scripts/system-one-judge-bench.ts', '--config', str(ROOT / 'mini-config.json'),
            '--fixtures', str(fixtures), '--out', str(ROOT / name), '--live', '--concurrency', '1']
    child = subprocess.Popen(args, cwd=REPO)
    start = time.monotonic()
    try:
        while child.poll() is None:
            current = memory()
            if current['availableFreeInactiveBytes'] < 1024**3:
                raise RuntimeError('free+inactive memory below1GiB reserve')
            if current['swapUsedBytes'] - baseline['swapUsedBytes'] > 256 * 1024**2:
                raise RuntimeError('swap growth exceeded256MiB')
            if current['swapoutBytes'] - baseline['swapoutBytes'] > 256 * 1024**2:
                raise RuntimeError('swapouts exceeded256MiB')
            if time.monotonic() - start > 900:
                raise RuntimeError('benchmark exceeded900s')
            time.sleep(1)
        if child.returncode:
            raise RuntimeError('benchmark failed')
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)


def sanity(config):
    rows = []
    for state, expected in [('The customer has a receipt.', True), ('The customer has no receipt.', False)]:
        payload = {'model': config['model'], 'state': state,
                   'questions': {'receipt': {'type': 'noul', 'instructions': 'Does the customer have a receipt?'}}}
        start = time.monotonic()
        req = urllib.request.Request('http://127.0.0.1:18944/v1/systemone', data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
        probability = data['answers']['receipt']['noul']
        rows.append({'state': state, 'expectedSanity': expected, 'result': data,
                     'latencyMs': (time.monotonic() - start) * 1000,
                     'method': 'API readout sanity/warmup,20s diagnostic budget, not promotion quality or production timeout policy'})
        (ROOT / 'mini-sanity-controls.json').write_text(json.dumps(rows, indent=2) + '\n')
        assert data['model'] == config['model'] and 0 <= probability <= 1
        assert (probability >= .5) == expected, 'readout sanity failed'


def main():
    assert sys.argv[1:] == ['--live'], 'requires explicit --live'
    assert not (ROOT / 'continuation-lifecycle.json').exists(), 'one-run output already exists'
    artifact = json.loads((ROOT / 'mini-artifact.json').read_text())
    assert Path(artifact['localPath']).stat().st_size == artifact['bytes']
    assert not m.available(18944)
    pid = json.loads((ROOT / 'previous-restoration.json').read_text())['pid']
    m.identity(pid, m.ORIGINAL_ARGS)
    config = json.loads((PREVIOUS / 'nano-config.json').read_text())
    config.update(model='d3-mini-q4-eval', quantization='Q4_K_M, no mmproj', revision='ggml-org/vllm-d3-mini-GGUF@' + artifact['revision'] + '/' + artifact['file'])
    (ROOT / 'mini-config.json').write_text(json.dumps(config, indent=2) + '\n')
    command = json.loads((PREVIOUS / 'nano-process.json').read_text())['command']
    command[command.index('-m') + 1] = artifact['localPath']
    command[command.index('--alias') + 1] = config['model']
    plan = {'frozenBeforeInferenceEpoch': time.time(), 'recipe': 'Direct binary0.5, no threshold tuning on complete T2 corpus; same previously frozen fixtures',
            'config': config, 'admission': 'After authorized Granite pause, free+inactive >= artifact bytes +1.5GiB; guard256MiB swap used/gross swapouts; no extra fleet model',
            'memoryBeforePause': memory(), 'authority': 'shadow only; no new authority or persistent service'}
    (ROOT / 'extension-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    try:
        m.stop(pid, m.ORIGINAL_ARGS, 8086)
        m.record('granite_paused_authorized', pid=pid)
        baseline = memory()
        m.record('post_pause_memory', **baseline)
        if baseline['availableFreeInactiveBytes'] < artifact['bytes'] + 1.5 * 1024**3:
            raise RuntimeError('not enough reclaimable headroom for artifact plus1.5GiB working/reserve budget')
        m.launch(command, 'mini')
        if memory()['availableFreeInactiveBytes'] < 1024**3:
            raise RuntimeError('loaded runtime leaves less than1GiB free+inactive reserve')
        sanity(config)
        bench('mini-reviewed', m.PACKET / 'ai-reviewed-judges-v2.jsonl', baseline)
        bench('t2-mini', m.PACKET / 't2-confirmatory-fixtures.jsonl', baseline)
        m.record('completed_quality_replays')
    except BaseException as error:
        m.record('extension_failed_or_aborted', reason=type(error).__name__ + ': ' + str(error))
        raise
    finally:
        try:
            if m.ACTIVE and m.available(18944):
                m.stop(*m.ACTIVE)
                m.ACTIVE = None
        finally:
            m.restore()
            for child in m.SAMPLERS:
                child.terminate()
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=1)
            m.record('finished_with_granite_restored')


if __name__ == '__main__':
    main()
