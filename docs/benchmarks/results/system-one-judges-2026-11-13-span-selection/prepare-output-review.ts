import { createHash, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { validateT2Body } from "../../../../packages/core/src/writers/t2-embed-text.ts";

const privateRoot = "/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection";
const root = import.meta.dirname;
const read = (name: string) => readFileSync(`${privateRoot}/${name}`, "utf8");
const jsonl = (name: string): any[] => read(name).trim().split("\n").map(line => JSON.parse(line));
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
if (existsSync(`${privateRoot}/output-review-packet.jsonl`)) throw new Error("Frozen packet already exists");
const inputs = jsonl("heldout.jsonl"), labels = new Map(jsonl("labels-adjudicated.jsonl").map(row => [row.caseId, row]));
const profiles = ["test-granite-v3", "test-z13-v3", "test-qwen2b-v3"];
const groups = profiles.flatMap(profile => ["legacy-full", "selection"].map(variant => ({ profile, variant })));
for (let i = groups.length - 1; i > 0; i--) { const j = randomInt(i + 1); [groups[i], groups[j]] = [groups[j]!, groups[i]!]; }
const key = Object.fromEntries(groups.map((group, index) => [String.fromCharCode(65 + index), group]));
const runs = new Map(profiles.map(profile => {
  const data = JSON.parse(read(profile + ".json"));
  if (data.split !== "test" || data.applied !== false || data.rows.length !== 76) throw new Error("Incomplete TEST run: " + profile);
  return [profile, data];
}));
let proposals = 0;
const packet = inputs.map(input => {
  const label = labels.get(input.id);
  if (!label || label.inputSha256 !== input.sha256 || digest(input.transcript) !== input.sha256) throw new Error("Input/label mismatch");
  const anonymousRuns = Object.entries(key).map(([anonymousRun, group]) => {
    const matched = runs.get(group.profile).rows.filter((row: any) => row.id === input.id && row.variant === group.variant);
    if (matched.length !== 1 || matched[0].inputSha256 !== input.sha256) throw new Error("Missing or repeated case/variant");
    const row = matched[0], memories = row.value ?? [];
    if (!Array.isArray(memories)) throw new Error("Non-array extraction");
    proposals += memories.length;
    const mechanicallyPromotable = memories.map((memory: any) => typeof memory.body === "string" && validateT2Body(memory.body).ok && memory.promote !== false && memory.is_episodic !== true && memory.obs_type !== "standing_brief" && (memory.body.trim().length >= 80 || (memory.depth ?? 0) >= 2));
    return { anonymousRun, memories, mechanicallyPromotable, abstention: "error" in row };
  });
  return { caseId: input.id, kind: input.kind, family: input.family, inputSha256: input.sha256, transcript: input.transcript, source: input.source, sourceChecks: input.sourceChecks, label, runs: anonymousRuns };
});
const encoded = packet.map(row => JSON.stringify(row)).join("\n") + "\n";
writeFileSync(`${privateRoot}/output-review-packet.jsonl`, encoded, { flag: "wx", mode: 0o600 });
writeFileSync(`${privateRoot}/output-review-key.json`, JSON.stringify(key, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const coverage = { cases: packet.length, anonymousRuns: groups.length, caseRunRows: packet.length * groups.length, proposals, packetSha256: digest(encoded), rawSha256: Object.fromEntries(profiles.map(profile => [profile, digest(read(profile + ".json"))])) };
writeFileSync(`${root}/review-coverage.json`, JSON.stringify(coverage, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(coverage));
