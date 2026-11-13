import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { T2Promotion } from "../../../../packages/core/src/writers/t2.ts";
import { TestEmbedder } from "../../../../packages/core/src/testing/index.ts";
import { buildT2ExtractionPrompt } from "../../../../packages/daemon/src/workers/t2-promotion.ts";

const privateRoot = "/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input";
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const previous = readFileSync("/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation/historical.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
const excludedSessions = new Set(previous.map((row) => row.source.sessionId));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const source = new Database("/Users/aimastermind/.penumbra/db.sqlite", { readonly: true, create: false });
source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000");
const rolls = source.query<{ rollup_id: string; session_id: string; started_at: string; project_id: string | null }, []>("SELECT rollup_id,session_id,started_at,project_id FROM t1_rollups WHERE started_at<'2026-11-07' ORDER BY started_at DESC,rollup_id LIMIT 1500").all();
rolls.sort((a, b) => sha("source-input-v1:" + a.session_id).localeCompare(sha("source-input-v1:" + b.session_id)));
const eventQuery = source.query<{ event_type: string; payload_summary: string | null; payload_json: string | null; ts: string }, [string]>("SELECT event_type,payload_summary,payload_json,ts FROM t0_events WHERE session_id=? AND event_type IN ('agent-prompt','agent-response') ORDER BY ts ASC");
const local = new Database(":memory:");
local.exec("CREATE TABLE t1_rollups(rollup_id TEXT,session_id TEXT,project_id TEXT,user_id TEXT,started_at TEXT,ended_at TEXT,origin TEXT,failed_promotion_attempts INTEGER DEFAULT 0,t2_promoted_at TEXT,promotion_filtered_at TEXT); CREATE TABLE t0_events(event_type TEXT,payload_summary TEXT,payload_json TEXT,session_id TEXT,ts TEXT)");
const cases: any[] = [];
const counts = { short: 0, medium: 0, long: 0 };
const seenSessions = new Set<string>(), seenInputs = new Set<string>();
const excluded = { previousSession: 0, duplicate: 0, budget: 0, studyContent: 0, empty: 0 };
for (const row of rolls) {
  if (excludedSessions.has(row.session_id)) { excluded.previousSession++; continue; }
  if (seenSessions.has(row.session_id)) { excluded.duplicate++; continue; }
  seenSessions.add(row.session_id);
  local.exec("DELETE FROM t1_rollups; DELETE FROM t0_events");
  local.run("INSERT INTO t1_rollups(rollup_id,session_id,project_id,user_id,started_at,ended_at) VALUES(?,?,?,'evaluation',?,?)", [row.rollup_id, row.session_id, row.project_id, row.started_at, row.started_at]);
  const events = eventQuery.all(row.session_id);
  for (const event of events) local.run("INSERT INTO t0_events VALUES(?,?,?,?,?)", [event.event_type, event.payload_summary, event.payload_json, row.session_id, event.ts]);
  async function capture(sourceTranscript: boolean): Promise<string> {
    let input = "";
    const promotion = new T2Promotion({ db: local, embedder: new TestEmbedder({ dim: 384 }), clock: () => new Date("2026-11-13"), uuid: () => "capture", minTranscriptChars: 0, sourceTranscript, ...(sourceTranscript ? { maxTranscriptChars: 240_000 } : {}), llm: (value) => { input = value; throw new Error("capture_done"); } });
    try { await promotion.promoteRollup(row.rollup_id); }
    catch (error) { if (!(error instanceof Error) || error.message !== "capture_done") throw error; }
    return input;
  }
  let transcript: string;
  try { transcript = await capture(true); }
  catch (error) { if (String(error).includes("character budget")) { excluded.budget++; continue; } throw error; }
  if (!transcript) { excluded.empty++; continue; }
  if (transcript.length > 60_000) { excluded.budget++; continue; }
  if (/system[- ]one|d3[- ]nano|system-one-judge|source-grounding requirements/i.test(transcript)) { excluded.studyContent++; continue; }
  if (seenInputs.has(sha(transcript))) { excluded.duplicate++; continue; }
  const stratum = transcript.length < 4000 ? "short" : transcript.length < 16000 ? "medium" : "long";
  if (counts[stratum] >= 8) continue;
  const legacyTranscript = await capture(false);
  seenInputs.add(sha(transcript)); counts[stratum]++;
  cases.push({ id: "source-" + String(cases.length + 1).padStart(2, "0"), transcript, sha256: sha(transcript), legacyTranscript, legacySha256: sha(legacyTranscript), stratum, source: { rollupId: row.rollup_id, sessionId: row.session_id, startedAt: row.started_at, projectId: row.project_id }, eventCount: events.length, summaries240: events.filter((event) => event.payload_summary?.length === 240).length });
  if (cases.length === 24) break;
}
source.close(); local.close();
if (cases.length !== 24) throw new Error("Insufficient fresh cases: " + JSON.stringify({ counts, excluded }));
process.env.PENUMBRA_T2_SOURCE_TRANSCRIPT = "1";
const policy = buildT2ExtractionPrompt("FROZEN_SOURCE_PLACEHOLDER");
const bytes = cases.map((row) => JSON.stringify(row)).join("\n") + "\n";
writeFileSync(privateRoot + "/historical.jsonl", bytes, { flag: "wx", mode: 0o600 });
writeFileSync(privateRoot + "/frozen-policy.txt", policy, { flag: "wx", mode: 0o600 });
writeFileSync(new URL("./cohort-manifest.json", import.meta.url), JSON.stringify({ method: "Read-only production SELECT; actual T2Promotion source and unchanged summary-first inputs captured in memory before inference. Exclude every previous generation-cohort session. SHA256-seeded session order among latest1500 pre-November7 rollups; eight cases per delivered source-length stratum, maximum60k chars. No population-random or future-data claim.", cases: 24, counts, excluded, privatePath: privateRoot + "/historical.jsonl", inputSha256: sha(bytes), frozenPolicySha256: sha(policy), sourceMode: { sourceTranscript: true, maxTranscriptChars: 240000, maxCharsPerChunk: 30000, maxChunks: 8, requireCompleteInput: true, concurrency: 1 }, caseHashes: cases.map((row) => ({ id: row.id, sha256: row.sha256, legacySha256: row.legacySha256, stratum: row.stratum, chars: row.transcript.length, legacyChars: row.legacyTranscript.length, eventCount: row.eventCount, summaries240: row.summaries240 })) }, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ cases: cases.length, counts, excluded, inputSha256: sha(bytes) }));
