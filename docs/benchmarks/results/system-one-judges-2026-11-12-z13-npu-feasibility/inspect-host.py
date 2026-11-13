"""Read-only SSH inventory. Does not initialize an accelerator or invoke inference."""

import json
import subprocess
import sys

REMOTE = r'''
import datetime, glob, json, os, pathlib, platform, resource, shutil, subprocess
p = pathlib.Path
def read(path):
    try: return p(path).read_text().strip()
    except OSError: return None
def command(args):
    r = subprocess.run(args, capture_output=True, text=True, timeout=8)
    return {"exitCode": r.returncode, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}
memory = {}
for line in p('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    if key in ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']:
        memory[key + 'Bytes'] = int(value.split()[0]) * 1024
cpus = [line.split(':', 1)[1].strip() for line in p('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')]
openers = []
for proc in p('/proc').iterdir():
    if not proc.name.isdigit(): continue
    try:
        devices = []
        for fd in (proc / 'fd').iterdir():
            try:
                target = os.readlink(fd)
                if target.startswith('/dev/accel/'):
                    devices.append({'device': target, 'fdinfo': read(proc / 'fdinfo' / fd.name)})
            except OSError: pass
        if devices:
            openers.append({'pid': int(proc.name), 'comm': read(proc / 'comm'), 'executable': os.readlink(proc / 'exe'), 'devices': devices})
    except OSError: pass
device = '/sys/class/accel/accel0/device/'
result = {
    'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'method': 'Read-only files/process/package inventory; no runtime initialization, inference, install, module load, configuration change or restart.',
    'kernel': platform.release(), 'osRelease': read('/etc/os-release'),
    'cpu': cpus[0] if cpus else None, 'memory': memory,
    'admissionFloorBytes': 20 * 1024**3,
    'availableAboveAdmissionBytes': memory['MemAvailableBytes'] - 20 * 1024**3,
    'amdxdnaLoaded': p('/sys/module/amdxdna').exists(),
    'accelDevices': sorted(str(x) for x in p('/dev/accel').glob('*')),
    'npu': {name: read(device + name) for name in ['vendor', 'device', 'revision', 'fw_version', 'vbnv', 'power/runtime_status']},
    'npuDeviceAccess': {'read': os.access('/dev/accel/accel0', os.R_OK), 'write': os.access('/dev/accel/accel0', os.W_OK)},
    'memlockBytes': resource.getrlimit(resource.RLIMIT_MEMLOCK),
    'binariesInSshPath': {name: shutil.which(name) for name in ['flm', 'lemonade-server', 'xrt-smi', 'xbutil']},
    'standardRuntimePaths': [x for pattern in ['/usr/bin/flm', '/usr/local/bin/flm', '/home/alex/.local/bin/flm', '/opt/xilinx/xrt*', '/usr/lib/xrt*', '/usr/lib/x86_64-linux-gnu/libxrt*'] for x in glob.glob(pattern)],
    'packages': command(['dpkg-query', '-W', '-f=${binary:Package} ${Version}\n', 'libxrt*', 'xrt*', '*amdxdna*', '*fastflow*', '*lemonade*']),
    'npuOpenersVisibleToSshUser': openers,
    'listening': command(['ss', '-ltnp']),
    'caveats': ['A single availability sample is not sustained spare capacity.', 'An open NPU descriptor is not evidence of an active hardware context or measured NPU utilization.', 'No runtime in the searched paths/packages does not exclude a custom installation elsewhere.', 'Negative memlock values denote unlimited.']
}
print(json.dumps(result, indent=2))
'''

host = sys.argv[1] if len(sys.argv) > 1 else "z13"
run = subprocess.run(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "python3 -"],
    input=REMOTE, text=True, capture_output=True, timeout=30, check=True,
)
print(json.dumps(json.loads(run.stdout), indent=2))
