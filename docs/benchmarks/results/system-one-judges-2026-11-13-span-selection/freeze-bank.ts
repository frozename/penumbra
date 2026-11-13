import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { T2Promotion } from "../../../../packages/core/src/writers/t2.ts";
import { TestEmbedder } from "../../../../packages/core/src/testing/index.ts";

const directory = "/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection";
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const excluded = new Set<string>();
for (const prior of ["generation", "source-input"]) {
  for (const line of readFileSync(`/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-${prior}/historical.jsonl`, "utf8").trim().split("\n")) excluded.add(JSON.parse(line).source.sessionId);
}
const source = new Database("/Users/aimastermind/.penumbra/db.sqlite", { readonly: true, create: false });
source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000");
const enriched = new Set<string>();
for (const row of source.query<{ source_session_ids: string }, []>("SELECT source_session_ids FROM t2_memories WHERE source_session_ids!='[]' ORDER BY created_at DESC LIMIT 2000").all()) {
  try { for (const id of JSON.parse(row.source_session_ids)) if (typeof id === "string") enriched.add(id); } catch {}
}
const rolls = source.query<{ rollup_id: string; session_id: string; started_at: string; project_id: string | null; origin: string | null }, []>("SELECT rollup_id,session_id,started_at,project_id,origin FROM t1_rollups WHERE started_at<'2026-11-10' ORDER BY started_at DESC,rollup_id LIMIT 4000").all();
const listed = new Set(rolls.map((row) => row.session_id));
for (const id of enriched) {
  if (listed.has(id)) continue;
  const row = source.query<{ rollup_id: string; session_id: string; started_at: string; project_id: string | null; origin: string | null }, [string]>("SELECT rollup_id,session_id,started_at,project_id,origin FROM t1_rollups WHERE session_id=? AND started_at<'2026-11-10' ORDER BY started_at DESC LIMIT 1").get(id);
  if (row) { rolls.push(row); listed.add(id); }
}
rolls.sort((a,b) => Number(enriched.has(b.session_id)) - Number(enriched.has(a.session_id)) || sha("span-bank-v1:" + a.session_id).localeCompare(sha("span-bank-v1:" + b.session_id)));
const eventQuery = source.query<{ event_type: string; payload_summary: string | null; payload_json: string | null; ts: string }, [string]>("SELECT event_type,payload_summary,payload_json,ts FROM t0_events WHERE session_id=? AND event_type IN ('agent-prompt','agent-response') ORDER BY ts ASC");
const local = new Database(":memory:");
local.exec("CREATE TABLE t1_rollups(rollup_id TEXT,session_id TEXT,project_id TEXT,user_id TEXT,started_at TEXT,ended_at TEXT,origin TEXT,failed_promotion_attempts INTEGER DEFAULT 0,t2_promoted_at TEXT,promotion_filtered_at TEXT); CREATE TABLE t0_events(event_type TEXT,payload_summary TEXT,payload_json TEXT,session_id TEXT,ts TEXT)");
const seen = new Set<string>(), hashes = new Set<string>();
const counts = { retainedSource: 0, otherRollup: 0 };
const cases: any[] = [];
for (const rollup of rolls) {
  if (excluded.has(rollup.session_id) || seen.has(rollup.session_id)) continue;
  seen.add(rollup.session_id);
  const stratum = enriched.has(rollup.session_id) ? "retainedSource" : "otherRollup";
  if (counts[stratum] >= 40) continue;
  local.exec("DELETE FROM t1_rollups; DELETE FROM t0_events");
  local.run("INSERT INTO t1_rollups(rollup_id,session_id,project_id,user_id,started_at,ended_at,origin) VALUES(?,?,?,'evaluation',?,?,?)", [rollup.rollup_id,rollup.session_id,rollup.project_id,rollup.started_at,rollup.started_at,rollup.origin]);
  for (const event of eventQuery.all(rollup.session_id)) local.run("INSERT INTO t0_events VALUES(?,?,?,?,?)", [event.event_type,event.payload_summary,event.payload_json,rollup.session_id,event.ts]);
  let transcript = "";
  const t2 = new T2Promotion({ db:local,embedder:new TestEmbedder({dim:384}),clock:()=>new Date("2026-11-13"),uuid:()=>"capture",minTranscriptChars:0,maxTranscriptChars:240000,sourceTranscript:true,llm:(value)=>{transcript=value;throw new Error("capture_done");} });
  try { await t2.promoteRollup(rollup.rollup_id); } catch (error) { if (!(error instanceof Error) || !["capture_done","source transcript exceeds character budget"].includes(error.message)) throw error; }
  if (transcript.length<100 || transcript.length>24000 || hashes.has(sha(transcript)) || /system[- ]one|d3[- ]nano|source-grounding requirements/i.test(transcript)) continue;
  counts[stratum]++; hashes.add(sha(transcript));
  cases.push({id:"bank-"+String(cases.length+1).padStart(3,"0"),transcript,sha256:sha(transcript),source:{rollupId:rollup.rollup_id,sessionId:rollup.session_id,startedAt:rollup.started_at,projectId:rollup.project_id,origin:rollup.origin}});
  if (cases.length===80) break;
}
source.close();local.close();
const bytes=cases.map(row=>JSON.stringify(row)).join("\n")+"\n";
writeFileSync(directory+"/candidate-bank.jsonl",bytes,{flag:"wx",mode:0o600});
writeFileSync(new URL("./candidate-bank-manifest.json",import.meta.url),JSON.stringify({method:"Read-only actual source-text capture, no inference or production writes. Up to forty source sessions associated with stored T2 records plus forty other T1 sources; source sessions are pre-November10, while the referencing stored record may be newer, SHA256 order within strata. Stored retention is sampling enrichment only, never ground truth; reviewers do not receive stored memory bodies or stratum labels. Exclude both earlier generation cohorts. Cases may overlap other task-domain studies; no universal never-seen claim.",cases:cases.length,counts,privatePath:directory+"/candidate-bank.jsonl",inputSha256:sha(bytes),caseHashes:cases.map(row=>({id:row.id,sha256:row.sha256,chars:row.transcript.length}))},null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({cases:cases.length,counts,inputSha256:sha(bytes)}));
