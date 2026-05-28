import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "/tmp/prod-eval-source.jsonl";
const TARGET = join(process.cwd(), "docs/notes/rewriter-eval-prod-2026-05-25.jsonl");

const LABELS: Record<
  string,
  { expected_verdict: "skip" | "query"; rationale: string; id: string }
> = {
  "985a7cb7-9ee2-4acf-8d12-ef082ad2e605": {
    id: "prod-engine-registry-tdd",
    expected_verdict: "skip",
    rationale: "engine registry is internal nomenclature; production bad-rewrite case",
  },
  "921683be-e013-444b-bc26-3326bc2c346b": {
    id: "prod-deps-getter",
    expected_verdict: "skip",
    rationale: "internal file path (deps.ts) and symbol (projectRegistry)",
  },
  "3b4abc38-5589-45ba-93b0-e5d7fe9eb85d": {
    id: "prod-session-note-2026-05-24",
    expected_verdict: "skip",
    rationale: "session log; no transferable concept",
  },
  "b2f136de-3930-422b-ad65-89a8f7cde500": {
    id: "prod-dispatch-land-fix",
    expected_verdict: "skip",
    rationale: "internal handler name dispatch_land + internal state",
  },
  "3e993c19-dda3-4c29-8fb5-ac7e3106c8d1": {
    id: "prod-split-behavior-change",
    expected_verdict: "skip",
    rationale: "too vague; no concept",
  },
  "61b02524-2a5e-4ca0-9154-3917641dddb0": {
    id: "prod-candidate-b-phase5",
    expected_verdict: "skip",
    rationale: "internal phase + project name",
  },
  "a7539a38-5843-40fe-91a3-c2981e9246ca": {
    id: "prod-candidate-b-shipped",
    expected_verdict: "skip",
    rationale: "internal Candidate B project label",
  },
  "ddbec646-2f15-48d1-805f-4d83d1d80a59": {
    id: "prod-session-2026-05-23",
    expected_verdict: "skip",
    rationale: "session log",
  },
  "37b2a27c-4057-47a8-8058-55f9dce95805": {
    id: "prod-p1-dream-dedup",
    expected_verdict: "skip",
    rationale: "internal dream cycle mechanism",
  },
  "f8406883-e6f7-4ddb-8525-b594eff36f22": {
    id: "prod-worker-token-split-brain",
    expected_verdict: "skip",
    rationale: "internal incident name + symbol",
  },
  "4bd13e47-83b5-4dc6-85fd-f1f2b4b321ea": {
    id: "prod-yaml-inline-comment",
    expected_verdict: "query",
    rationale:
      "YAML inline-comment parsing edge case IS a public concern; projects.yaml is internal but the underlying YAML behavior is broadly relevant",
  },
  "0069e346-6d2b-4581-aa27-98b7e57c03f9": {
    id: "prod-p5-cache-key-mismatch",
    expected_verdict: "skip",
    rationale: "internal cycle phase + bug fix",
  },
  "e9952376-c0a5-473d-a1af-2678245f4071": {
    id: "prod-workflowctx-storageroot",
    expected_verdict: "skip",
    rationale: "internal API surface (WorkflowCtx, storageRoot)",
  },
  "e9d4422e-e35b-415c-a6ce-c3931ed27425": {
    id: "prod-tsfn-workflow-string",
    expected_verdict: "skip",
    rationale: "internal workflow runtime quirk",
  },
  "c99bef5f-d18a-4cd3-965c-53920838d4c4": {
    id: "prod-t2vec-noautoreset",
    expected_verdict: "skip",
    rationale: "internal table name",
  },
  "32aa336a-ad0e-4824-8aa2-d680363e2d7d": {
    id: "prod-sqlite-unique-null",
    expected_verdict: "query",
    rationale: "real public SQLite behavior; COALESCE workaround is a public pattern",
  },
  "a2587a62-27f8-43bf-b0ba-dda247289dd6": {
    id: "prod-granite-assistant-tag",
    expected_verdict: "query",
    rationale:
      "Granite is a public Hugging Face model; the </assistant> tag artifact is a real issue developers encounter",
  },
  "f3dce36a-41be-48d7-ac2e-d3acc14a3675": {
    id: "prod-postgres-vs-sqlite-audit",
    expected_verdict: "query",
    rationale: "both are public databases; choice rationale for audit logs is broadly searchable",
  },
  "e75e42c5-d066-4b9c-903f-f8baa9cc3fa1": {
    id: "prod-vitest-vs-jest",
    expected_verdict: "skip",
    rationale: "personal preference; not a transferable concept",
  },
  "fa2ef142-076f-4f7e-a7af-c509c086be70": {
    id: "prod-typecheck-before-tests",
    expected_verdict: "skip",
    rationale: "workflow preference; too generic to query usefully",
  },
  "0374e0c2-a680-4b65-8bc3-e93742e38e3a": {
    id: "prod-dispatch-trust-all",
    expected_verdict: "skip",
    rationale: "internal convention (trust=all is project-specific)",
  },
  "dc0f6cc5-86df-4a8d-9c2c-60581aadba2c": {
    id: "prod-agent-branch-naming",
    expected_verdict: "skip",
    rationale: "internal naming pattern (agent/<handoff_id>)",
  },
  "17155422-b247-41cf-9f24-0a25edb25130": {
    id: "prod-brief-penumbra",
    expected_verdict: "skip",
    rationale: "internal project brief",
  },
  "048ab24b-e512-4386-ab29-cb7a9c1c8fb5": {
    id: "prod-antigravity-bridge-plan",
    expected_verdict: "skip",
    rationale: "internal plan, agy-acp-shim is internal name",
  },
  "d32c9ef2-21be-4876-9fde-adc5c0d3b43a": {
    id: "prod-retired-synthetic-memories",
    expected_verdict: "skip",
    rationale: "internal data cleanup operation",
  },
};

const out: string[] = [];
for (const line of readFileSync(SOURCE, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  const label = LABELS[row.memory_id];
  if (!label) {
    console.error(`No label for memory_id ${row.memory_id} — skipping`);
    continue;
  }
  out.push(
    JSON.stringify({
      id: label.id,
      title: row.title,
      body_first_200: row.body_first_200,
      expected_verdict: label.expected_verdict,
      rationale: label.rationale,
      memory_id: row.memory_id,
      cached_verdict_qwen: row.cached_verdict_qwen,
    }),
  );
}

writeFileSync(TARGET, out.join("\n") + "\n");
process.stdout.write(`Wrote ${out.length} cases to ${TARGET}\n`);
