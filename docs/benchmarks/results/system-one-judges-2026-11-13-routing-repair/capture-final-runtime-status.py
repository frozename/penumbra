import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parent
out = root / 'final-runtime-status.json'
if out.exists():
    raise SystemExit('Fresh status record required')


def call(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


label = f'gui/{os.getuid()}/dev.penumbra.local-judges'
supervision = subprocess.check_output(['launchctl', 'print', label], text=True)
pid = int(re.search(r'\n\s+pid = (\d+)', supervision)[1])
deadline = time.monotonic() + 45
while True:
    models = call('http://127.0.0.1:18944/v1/models')['data']
    if all(m['status']['value'] in ['unloaded', 'sleeping'] for m in models):
        break
    if time.monotonic() >= deadline:
        raise RuntimeError('Runtime still active; inspect workloads before capturing an idle snapshot')
    time.sleep(1)
rows = [line.split(None, 3) for line in subprocess.check_output(
    ['ps', '-axo', 'pid=,ppid=,rss=,args='], text=True).splitlines()]
processes = [{'pid': int(p), 'ppid': int(parent), 'rssKiB': int(rss)}
             for p, parent, rss, args in rows if int(p) == pid or int(parent) == pid]
with socket.socket() as probe:
    probe.settimeout(1)
    qwen_port_open = probe.connect_ex(('127.0.0.1', 18945)) == 0
assert not qwen_port_open
proof = json.loads((root.parent / 'system-one-judges-2026-11-13-generation-split/generation-staging-proof.json').read_text())
agents_hash = hashlib.sha256((Path.home() / '.config/penumbra/agents.yaml').read_bytes()).hexdigest()
assert agents_hash == proof['originalAgentsSha256']
plist_hash = hashlib.sha256((Path.home() / 'Library/LaunchAgents/dev.penumbra.local-judges.plist').read_bytes()).hexdigest()
assert plist_hash == 'b52d90c7f32eead8d1ddc233ba7059621fad866f9e5403ad8454387da731999d'

gufo_script = '''import json,os,urllib.request
pid=791917
with urllib.request.urlopen("http://127.0.0.1:8080/health",timeout=5) as r:health=json.load(r)
with urllib.request.urlopen("http://127.0.0.1:8080/slots",timeout=5) as r:slots=json.load(r)
mem={line.split(":")[0]:int(line.split()[1])*1024 for line in open("/proc/meminfo") if line.startswith(("MemTotal:","MemAvailable:","SwapTotal:","SwapFree:"))}
print(json.dumps({"gufoPid":pid,"sameProcessAlive":os.path.exists(f"/proc/{pid}"),"executable":os.readlink(f"/proc/{pid}/exe"),"health":health,"slots":[{"id":s.get("id"),"is_processing":s.get("is_processing")} for s in slots],"memory":mem}))
'''
gufo = json.loads(subprocess.check_output(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'z13', 'python3 -'],
    input=gufo_script, text=True, timeout=20))

llamactl = '/Volumes/AI-DATA/maestro/bench/df-round1/agent-upgrade/wz-staging-20261110/wt-tz'
kapitsa_script = f'''
import {{loadConfig,resolveNode,resolveToken}} from "{llamactl}/packages/core/src/config/kubeconfig.ts";
import {{makePinnedFetch}} from "{llamactl}/packages/remote/src/client/links.ts";
const {{node,user}}=resolveNode(loadConfig(),"m4-pro");
const r=await makePinnedFetch(node)(node.endpoint+"/trpc/modelHostStatus?input="+encodeURIComponent(JSON.stringify({{workload:"kapitsa-q35-eval"}})),{{headers:{{Authorization:"Bearer "+resolveToken(user)}},signal:AbortSignal.timeout(5000)}});
if(!r.ok)throw new Error("Model host status HTTP "+r.status);
const data=(await r.json()).result.data;
console.log(JSON.stringify({{state:data.state,pid:data.pid,samePid:data.pid===39656,rpcIncludesOsHeadroom:false}}));
'''
kapitsa = json.loads(subprocess.check_output(['bun', '-e', kapitsa_script], text=True, timeout=15))
macbook_script = '''import datetime,json,re,subprocess,urllib.request
vm=subprocess.check_output(["vm_stat"],text=True)
page=int(re.search(r"page size of (\\d+)",vm)[1])
headroom=sum(int(re.search(re.escape(k)+r":\\s+(\\d+)",vm)[1]) for k in ["Pages free","Pages inactive"])*page
with urllib.request.urlopen("http://127.0.0.1:18200/health",timeout=3) as response:health=json.load(response)
connections=subprocess.run(["/usr/sbin/lsof","-nP","-a","-p","39656","-iTCP:18200","-sTCP:ESTABLISHED","-Ff"],capture_output=True,text=True)
print(json.dumps({"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"freePlusInactiveBytes":headroom,"pressureLevel":int(subprocess.check_output(["sysctl","-n","kern.memorystatus_vm_pressure_level"],text=True)),"health":health,"establishedConnections":sum(line.startswith("f") for line in connections.stdout.splitlines())}))
'''
kapitsa['postStudyOsSample'] = json.loads(subprocess.check_output(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no', 'acordeiro@192.168.68.140', 'python3 -'],
    input=macbook_script, text=True, timeout=15))
report = {
    'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'method': 'Read-only status snapshots after routing/privacy repair validation. No model inference or service mutation.',
    'mini': {'health': call('http://127.0.0.1:51257/health')['status'],
             'judgeRuntimeHealth': call('http://127.0.0.1:18944/health')['status'],
             'supervisorPid': pid, 'plistSha256': plist_hash, 'liveAgentsSha256': agents_hash,
             'models': [{'id': m['id'], 'state': m['status']['value']} for m in models],
             'processes': processes, 'aggregateRssMiB': sum(p['rssKiB'] for p in processes) / 1024,
             'ephemeralEvaluationPortOpen': qwen_port_open,
             'rssCaveat': 'Discrete idle snapshot, not physical footprint or peak. Shared pages may be counted twice.'},
    'kapitsa': kapitsa, 'gufo': gufo, 'productionGenerationRolesChanged': False,
    'newPromotionOrVetoAuthority': False,
    'qualityAccepted': False, 'qualityAcceptanceScope': 'See paired repair report; no new model authority or production source deployed.',
    'capacityCaveat': 'Health, unchanged PIDs and idle slots do not establish coding priority, peak memory or load isolation.'
}
out.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
