/**
 * write-evidence-md.ts — renders the .md half of the evidence pair from the
 * committed .json alone (renderEvidenceMarkdown). SHAPE renders the committed
 * .json again and requires the committed .md to be byte-equal, so every count
 * in the .md inherits the .json's bindings. Every tarball mention in prose
 * carries the "channel stand-in" label (SHAPE checks it per table row, list
 * item and paragraph, code spans excluded).
 */
import type { Step } from "./write-evidence-gates.js";

export interface Section2Row {
  origin: string;
  kind: string;
  origin_pass: number;
  origin_fail: number;
  origin_ran: number;
  parity: string | null;
  parity_pass: number | null;
  parity_fail: number | null;
  excluded: { reason: string }[];
  consistent: boolean;
}

export interface PerFileRow {
  origin: string;
  baseline_tests: number;
  ported: number;
  passed: number;
  not_portable: number;
  reason: string;
  adaptations: unknown[];
}

export interface MdInput {
  head: string;
  headNote: string;
  baseSha: string;
  toolchain: string;
  /** "bun <v> and node <v>": the PATH toolchain the check requires. */
  pathToolchain: string;
  generatedAt: string;
  result: string;
  gates: Record<string, unknown>[];
  checkSteps: Step[];
  mutations: unknown[];
  cleanAfter: unknown;
  tarball: Record<string, unknown>;
  consumers: Record<string, unknown>;
  section2Rows: Section2Row[];
  delta: number;
  perFile: PerFileRow[];
  excludedCases: { origin_title: string; module: string; reason: string }[];
  deviations: Record<string, unknown>[];
  openFindings: Record<string, unknown>[];
  claimsNotMade: string[];
  blockers: Record<string, unknown>;
  /** [tag] titles passing in this run's gate log. */
  tagPasses: Record<string, number>;
  t7Overshoot: number | null;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}
function recList(v: unknown): Record<string, unknown>[] {
  return list(v).map((x) => rec(x) ?? {});
}

function verdictLine(g: Record<string, unknown>): string {
  const parts = rec(g["parts"]);
  let extra = "";
  if (g["gate"] === "L2") extra = ` (${str(g["verdict_scope"])})`;
  if (g["gate"] === "L3") {
    extra = ` (penumbra=${str(parts?.["penumbra"])}, synthetic=${str(parts?.["synthetic"])}, llamactl=DEFERRED → ${str(g["deferred_to"])})`;
  }
  return `- ${str(g["gate"])}: ${str(g["verdict"])}${extra}`;
}

const GATE_INTRO: Record<string, string> = {
  L2: "Both consumers ran inside this worktree against a locally packed tarball used as a channel stand-in — nothing here asserts a versioned channel, a package home, or a llamactl-side install.\n\n",
  L6: "Warm pooling is not a resume mechanism: the pool reuses idle child processes within one host process lifetime and carries no session state.\n\n",
};

function gateSection(g: Record<string, unknown>, t7: string): string {
  const gate = str(g["gate"]);
  const ev = (Array.isArray(g["evidence"]) ? g["evidence"] : [])
    .map((e) => rec(e) ?? {})
    .map((e) => {
      const wc =
        e["would_confirm"] === undefined ? "" : `; would confirm: ${str(e["would_confirm"])}`;
      return `  - ${str(e["claim"])} — ${str(e["status"])} (\`${str(e["pointer"])}\`)${wc}`;
    })
    .join("\n");
  const nph = stringList(g["not_provable_here"])
    .map((s) => `  - ${s}`)
    .join("\n");
  const heading = gate === "L2" ? "## L2 packed artifact (channel stand-in)" : `## ${gate}`;
  const extra = gate === "L4" ? `\n\n${t7}` : "";
  return `${heading}\n\n${GATE_INTRO[gate] ?? ""}Verdict: ${str(g["verdict"])} (scope: branch)\n\nEvidence:\n${ev}\n\nNot provable here:\n${nph}${extra}`;
}

function t7Line(t7: number | null): string {
  return t7 === null
    ? "T7 overshoot: no `t7-overshoot=` marker in the gate log."
    : `T7 overshoot: ${String(t7)} bytes past the 65536-byte limit (the \`t7-overshoot=\` marker the [B10] output-limit test prints into the gate log). It varies run to run with pipe chunking and stays within the largest chunk, so SHAPE binds it to the measured domain (a whole number of 65536-byte reads) rather than to a fixed value.`;
}

function stepRow(g: Step): string {
  const counts = g.pass === null ? "" : ` · ${String(g.pass)}p/${String(g.fail ?? "?")}f`;
  const gating = g.gating === false ? " (non-gating)" : "";
  return `| \`${String(g.gate)}\` | \`${str(g.log)}\` | exit ${String(g.exit)}${counts}${gating} |`;
}

function mutationRow(m: unknown): string {
  const r = rec(m) ?? {};
  const failing = Array.isArray(r["failing_tests"]) ? r["failing_tests"].length : 0;
  const detection = r["detected"] === true ? "detected" : "MISSED";
  return `| ${str(r["patch"])} | ${str(r["intent"])} | ${detection} (${String(failing)} failing; expected-detectors ${String(r["expected_detectors_hit"])}; post-revert-green ${String(r["post_revert_green"])}) |`;
}

function redGreenRow(m: unknown, tagPasses: Record<string, number>): string {
  const r = rec(m) ?? {};
  const tag = str(r["tag"]);
  const red = `${String(r["fail"])} failing / ${String(r["ran"])} ran (exit ${String(r["test_exit_code"])})`;
  const green = r["post_revert_green"] === true ? "green" : "NOT green";
  return `| [${tag}] | ${str(r["patch"])} | ${red} | ${green} | ${String(tagPasses[tag] ?? 0)} |`;
}

function consumerRow(consumers: Record<string, unknown>, name: string): string {
  const c = rec(consumers[name]);
  if (c === undefined) return `| ${name} | missing | — | — | — |`;
  const steps = (Array.isArray(c["steps"]) ? c["steps"] : []) as Step[];
  const stepText = steps
    .map((s) => {
      const counts =
        (s.pass ?? 0) > 0 || (s.fail ?? 0) > 0 ? ` (${String(s.pass)}p/${String(s.fail)}f)` : "";
      return `${String(s.name)} exit ${String(s.exit)}${counts}`;
    })
    .join(" · ");
  return `| ${name} | ${str(c["runtime"])} | \`bun add ${str(c["install_specifier"])}\` | \`${str(c["resolved_to"])}\` | ${stepText} |`;
}

function section2Row(r: Section2Row): string {
  const parity =
    r.parity === null
      ? "context slice (not ported)"
      : `\`${r.parity}\` → ${String(r.parity_pass)}p/${String(r.parity_fail)}f`;
  const rows = recList(r.excluded);
  const more = rows.length > 1 ? ", …" : "";
  const excluded =
    rows.length === 0
      ? "—"
      : `${String(rows.length)} excluded (${str(rows[0]?.["reason"])}${more})`;
  return `| \`${r.origin}\` | ${r.kind} | ${String(r.origin_pass)}p/${String(r.origin_fail)}f (${String(r.origin_ran)} ran) | ${parity} | ${excluded} | ${r.consistent ? "consistent" : "INCONSISTENT"} |`;
}

function perFileRow(f: PerFileRow): string {
  return `| \`${f.origin}\` | ${String(f.baseline_tests)} | ${String(f.ported)} | ${String(f.passed)} | ${String(f.not_portable)} | ${String(list(f.adaptations).length)} | ${f.reason} |`;
}

function blockerLine([id, b]: [string, unknown]): string {
  const r = rec(b) ?? {};
  return `| ${id} | ${str(r["status"])} | ${str(r["evidence"])} |`;
}

function findingLine(f: Record<string, unknown>): string {
  const wc = f["would_confirm"] === undefined ? "" : ` (would confirm: ${str(f["would_confirm"])})`;
  return `- \`${str(f["id"])}\` [${str(f["status"])}] ${str(f["finding"])}${wc}`;
}

function headerBlock(i: MdInput): string {
  return `# Qualification — penumbra-exec-primitives (P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from \`packages/agentchat/src/adapters/\`. This report asserts nothing
about adoption, release, publication, package home, or registry state. Every
tarball mention below refers to a local channel stand-in, never a versioned
channel.

Commit: \`${i.head}\` (head_sha: ${i.headNote}) — base: \`${i.baseSha}\`
Toolchain: ${i.toolchain}
Generated: ${i.generatedAt}
Result (derived): ${i.result}

Superseded evidence: commit \`eac2182fe\` carries an earlier evidence pair (its dist audit exited 1); it stays in branch history, this pair supersedes it, and the PR merge squashes it away.`;
}

function tarballBlock(t: Record<string, unknown>): string {
  const entries = Array.isArray(t["entries"]) ? t["entries"].length : 0;
  return `## Tarball (channel stand-in)

\`${str(t["name"])}\` — ${String(t["files"])} files, ${String(t["unpacked_bytes"])} bytes unpacked. This tarball is a local channel stand-in.

- \`sha256(tgz) = ${str(t["sha256"])}\`
- \`content_sha256 = ${str(t["content_sha256"])}\` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent \`bun pm pack\` runs → byte_reproducible=${String(t["byte_reproducible"])}
- entries: ${String(entries)} (package.json, LICENSE, README.md, dist/src/** only)`;
}

function consumersBlock(i: MdInput): string {
  return `## Consumers

Each consumer fixture is copied to \`tmp/sharedlib6/consumer-<name>/\` and installs
the packed tarball (channel stand-in) via \`bun add\` under an isolated HOME and bun
cache, against a poisoned \`@penumbra/*\` resolution layer so a workspace link can
never mask a missing install. The install fetched typescript and @types/node from
the registry (\`network_required: true\`); the runtime steps ran with dead proxy
variables.

| Host | Runtime | Install | Resolved to | Steps |
| ---- | --- | --- | --- | --- |
${consumerRow(i.consumers, "penumbra-host")}
${consumerRow(i.consumers, "infra-host")}

Installed-content digest equals the tarball (channel stand-in) digest for each
consumer (\`digest_equal\`), \`home_entries_after\` is empty for both isolated
HOMEs, and the per-copy poison run passes 0 tests against the broken entry.`;
}

function section2Block(i: MdInput): string {
  const excluded = i.excludedCases
    .map((e) => `- \`${e.module}\` — "${e.origin_title}" — ${e.reason}`)
    .join("\n");
  return `## Section 2 — adapter-surface parity vs \`packages/agentchat/\`

Origin slices are measured fresh each run (\`section2-slice.ts\`); parity counts
come from the per-file parity steps inside the penumbra-host consumer copy.
Baseline and after carry a delta of ${String(i.delta)}.

| Origin | Disposition | Origin result | Parity result | Exclusions | Verdict |
| --- | --- | --- | --- | --- | --- |
${i.section2Rows.map(section2Row).join("\n")}

Per-file parity table (baseline_tests = ported + not_portable; SHAPE binds each
count to the section-2 baseline, the parity step and excluded_cases):

| Origin | baseline_tests | ported | passed | not_portable | adaptations | reason |
| --- | --- | --- | --- | --- | --- | --- |
${i.perFile.map(perFileRow).join("\n")}

Excluded origin executions (exercising surfaces deliberately not extracted):
${excluded === "" ? "- none" : excluded}`;
}

const BOUNDARY_TABLE = `Boundary imports removed (per extraction contract):

| Adapter source | Removed import | Replaced by |
| --- | --- | --- |
| \`cli-spawn.ts\` | \`@penumbra/core\` (DispatchEventInput), \`@src/sdk/adapter.js\` (DispatchEvent), \`@src/worker/thought-capture.js\` | generic supervision in \`process-supervisor.ts\` |
| \`stdio-acp-permission.ts\` | \`@src/sdk/adapter.js\` (DispatchInput) | \`PermissionHost\` — host passes \`signal\`, \`dispatchId\`, \`decide\`, \`logger\` |
| \`stdio-acp-server.ts\` | none (was already local) | \`console.error\` → \`logger\`; stderr tee → \`onStderrChunk\` callback |
| \`stdio-acp-client.ts\` | none | \`console.*\` → \`ExecLogger\`; close-guards added |
| \`acp-warm-pool.ts\` | \`@src/adapters/stdio-acp-client.js\` (type-level) | \`AcpPoolClient\` structural type (no runtime import) |`;

export function renderMarkdown(i: MdInput): string {
  const deviations = i.deviations
    .map(
      (d) =>
        `| ${str(d["rule"])} | ${str(d["change"])} | ${str(d["reason"])} | \`${str(d["pointer"])}\` |`,
    )
    .join("\n");
  return `${headerBlock(i)}

## Verdicts

${i.gates.map(verdictLine).join("\n")}

## Check steps

| Step | Log | Result |
| --- | --- | --- |
${i.checkSteps.map(stepRow).join("\n")}

${i.gates.map((g) => gateSection(g, t7Line(i.t7Overshoot))).join("\n\n")}

## Blockers

| Blocker | Status | Evidence |
| --- | --- | --- |
${Object.entries(i.blockers).map(blockerLine).join("\n")}

## Mutations

${String(i.mutations.length)} patches; clean after revert: \`${String(i.cleanAfter)}\`.

| Patch | Intent | Detection |
| --- | --- | --- |
${i.mutations.map(mutationRow).join("\n")}

## RED/GREEN

RED is the package suite with the patch applied; GREEN is the same suite after
the revert, and the last column counts the tag's titles passing in the gate log.

| Tag | Patch | RED (suite under the patch) | GREEN (after revert) | [tag] passing in gate |
| --- | --- | --- | --- | --- |
${i.mutations.map((m) => redGreenRow(m, i.tagPasses)).join("\n")}

${tarballBlock(i.tarball)}

${consumersBlock(i)}

${section2Block(i)}

${BOUNDARY_TABLE}

## Deviations

| Rule | Change | Reason | Pointer |
| --- | --- | --- | --- |
${deviations}

## Open findings

${i.openFindings.map(findingLine).join("\n")}

## Claims not made

${i.claimsNotMade.map((c) => `- ${c}`).join("\n")}

## Reproduce

Toolchain: ${i.pathToolchain} must be the first \`bun\` and \`node\` on PATH (typescript comes from the lockfile). sharedlib6-check.ts stops at its prechecks, naming the binaries PATH resolves, when either differs from \`toolchain\`; with --keep it prints the mismatch and SHAPE fails.

\`\`\`sh
bun install --frozen-lockfile
bun packages/exec-primitives/scripts/sharedlib6-check.ts --keep
bun packages/exec-primitives/scripts/write-evidence.ts
bun packages/exec-primitives/scripts/sharedlib6-shape-selftest.ts
\`\`\`

## Scope

The packed tarball exercised here is a local channel stand-in. Parity is
bounded by the suites actually executed and recorded above; nothing about
distribution, hosting, or downstream adoption follows from this record.
`;
}

/** MdInput read from an evidence object; missing fields render as empty. */
export function mdInputFromEvidence(ev: Record<string, unknown>): MdInput {
  const tool = rec(ev["toolchain"]) ?? {};
  const parity = rec(ev["parity"]) ?? {};
  const t7 = rec(rec(list(ev["gates"])[3])?.["measurements"])?.["t7_overshoot_bytes"];
  const tagPasses = rec(rec(ev["red_green"])?.["tag_passes"]) ?? {};
  return {
    head: str(ev["head_sha"]),
    headNote: str(ev["head_sha_note"]),
    baseSha: str(ev["base_sha"]),
    toolchain: `bun ${str(tool["bun"])} · node ${str(tool["node"])} · typescript ${str(tool["typescript"])}`,
    pathToolchain: `bun ${str(tool["bun"])} and node ${str(tool["node"])}`,
    generatedAt: str(ev["generated_at"]),
    result: str(ev["result"]),
    gates: recList(ev["gates"]),
    checkSteps: recList(ev["check_steps"]) as unknown as Step[],
    mutations: list(ev["mutations"]),
    cleanAfter: ev["mutations_clean_after"],
    tarball: rec(ev["tarball"]) ?? {},
    consumers: rec(ev["consumers"]) ?? {},
    section2Rows: recList(
      rec(rec(ev["section2"])?.["verdict"])?.["rows"],
    ) as unknown as Section2Row[],
    delta: typeof ev["delta"] === "number" ? ev["delta"] : Number.NaN,
    perFile: recList(parity["per_file"]) as unknown as PerFileRow[],
    excludedCases: recList(parity["excluded_cases"]) as unknown as MdInput["excludedCases"],
    deviations: recList(ev["deviations"]),
    openFindings: recList(ev["open_findings"]),
    claimsNotMade: stringList(ev["claims_not_made"]),
    blockers: rec(ev["blockers"]) ?? {},
    tagPasses: Object.fromEntries(
      Object.entries(tagPasses).map(([k, v]) => [k, typeof v === "number" ? v : Number.NaN]),
    ),
    t7Overshoot: typeof t7 === "number" ? t7 : null,
  };
}

/** The .md for an evidence object — the one render the writer and SHAPE share. */
export function renderEvidenceMarkdown(ev: Record<string, unknown>): string {
  return renderMarkdown(mdInputFromEvidence(ev));
}
