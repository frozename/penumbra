import fcntl,hashlib,json,os,re,subprocess,time,urllib.request
from pathlib import Path
root=Path("docs/benchmarks/results/system-one-judges-2026-11-13-routing-repair")
out=root/"managed-warmed-availability.json"
assert not out.exists()
def call(url):
    with urllib.request.urlopen(url,timeout=3)as r:return json.load(r)
def headroom():
    vm=subprocess.check_output(["vm_stat"],text=True);page=int(re.search(r"page size of (\d+)",vm)[1])
    return sum(int(re.search(re.escape(k)+r":\s+(\d+)",vm)[1])for k in ["Pages free","Pages inactive"])*page
label=f"gui/{os.getuid()}/dev.penumbra.local-judges"
lock=(Path.home()/".penumbra/locks/heavy-job.lock").open("a");fcntl.flock(lock,fcntl.LOCK_EX)
try:
    assert call("http://127.0.0.1:51257/health")["status"]=="ok"
    assert headroom()>=3619691840+1.5*1024**3
    assert all(x["status"]["value"]in ["sleeping","unloaded"]for x in call("http://127.0.0.1:18944/v1/models")["data"])
    before=Path.home()/"Library/LaunchAgents/dev.penumbra.local-judges.plist";digest=hashlib.sha256(before.read_bytes()).hexdigest()
    request=urllib.request.Request("http://127.0.0.1:18944/v1/chat/completions",data=json.dumps({"model":"granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf","messages":[{"role":"user","content":"Return exactly {\"kind\":\"skip\",\"reason\":\"availability probe\"}."}],"temperature":0,"max_tokens":32,"response_format":{"type":"json_object"}}).encode(),headers={"Content-Type":"application/json"})
    start=time.monotonic()
    with urllib.request.urlopen(request,timeout=5)as response:data=json.load(response)
    latency=(time.monotonic()-start)*1000
    value=json.loads(data["choices"][0]["message"]["content"])
    assert data["choices"][0]["finish_reason"]=="stop" and value["kind"]=="skip" and value["reason"]
    deadline=time.monotonic()+45
    while True:
        models=call("http://127.0.0.1:18944/v1/models")["data"]
        if all(x["status"]["value"]in ["sleeping","unloaded"]for x in models):break
        if time.monotonic()>deadline:raise RuntimeError("Still active after probe; no forced unload")
        time.sleep(1)
    status=subprocess.check_output(["launchctl","print",label],text=True);pid=int(re.search(r"\n\s+pid = (\d+)",status)[1])
    processes=[line.split(None,3)for line in subprocess.check_output(["ps","-axo","pid=,ppid=,rss=,args="],text=True).splitlines()]
    owned=[{"pid":int(p),"ppid":int(parent),"rssKiB":int(rss)}for p,parent,rss,args in processes if int(p)==pid or int(parent)==pid]
    all_llama=[{"pid":int(p),"ppid":int(parent),"rssKiB":int(rss)}for p,parent,rss,args in processes if args.split()[0].endswith("/llama-server")or args.split()[0]=="llama-server"]
    assert hashlib.sha256(before.read_bytes()).hexdigest()==digest
    result={"method":"One fixed synthetic managed Q8 availability request after CI, no private input/queue/cache/authority/role changes. Wait for natural autosleep; discrete RSS snapshot, not quality, physical footprint or sustained-load proof.","model":data.get("model"),"coldManagedRequestMs":latency,"passed":True,"models":[{"id":x["id"],"state":x["status"]["value"]}for x in models],"processes":owned,"aggregateWarmedIdleRssMiB":sum(x["rssKiB"]for x in owned)/1024,"allMiniLlamaProcesses":all_llama,"plistUnchanged":True,"daemonHealth":call("http://127.0.0.1:51257/health")["status"],"applied":False}
    with out.open("x")as f:json.dump(result,f,indent=2);f.write("\n")
    print(json.dumps(result),flush=True)
finally:fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
