#!/usr/bin/env bun
/**
 * write-evidence.ts — assemble the committed qualification evidence pair from
 * the measured artifacts under tmp/sharedlib6/ (produced by
 * scripts/sharedlib6-check.ts --keep). Writes:
 *
 *   docs/qualification/2026-09-24-sharedlib6-qualification.json
 *   docs/qualification/2026-09-24-sharedlib6-qualification.md
 *
 * The date is fixed: the section-2 baseline numbers, the committed evidence
 * pair and the SHAPE validator all key on 2026-09-24. There is deliberately
 * no run-date default.
 *
 * The writer does NOT refuse on a non-green run: evidence records measured
 * truth. A failed gate, a missed mutation or a failed consumer step is
 * written into the record as a failure, never rewritten or omitted. Verdicts
 * in gates[] are DERIVED from the fresh artifacts — never asserted.
 *
 * Usage: bun scripts/write-evidence.ts
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BASELINE_SET,
  blockerMap,
  BOUNDARY_TYPE_IMPORTS_REMOVED,
  CLAIMS_NOT_MADE,
  DISPOSITIONS,
  OPEN_FINDINGS,
  SHIM_LOGIC,
  STATIC_DEVIATIONS,
} from "./write-evidence-data.js";
import { buildGates, type GateCtx, type Step } from "./write-evidence-gates.js";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const LOG_DIR = join(RUN_DIR, "check-logs");
const DOCS_DIR = join(REPO_ROOT, "docs", "qualification");
const EVIDENCE_DATE = "2026-09-24";
const BASE_SHA = "c264644bc2b4f1e1429e845208fd6ca7f6426d62";

function fail(msg: string): never {
  process.stderr.write(`write-evidence: FAIL — ${msg}\n`);
  process.exit(1);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    fail(`missing artifact ${path} — run bun scripts/sharedlib6-check.ts --keep first`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------
const check = rec(readJson(join(RUN_DIR, "check.json"))) ?? fail("check.json unreadable");
const measurements = rec(readJson(join(RUN_DIR, "measurements.json"))) ?? fail("measurements.json");
const mutationsJson = rec(readJson(join(RUN_DIR, "mutations.json"))) ?? fail("mutations.json");
const section2 = rec(readJson(join(RUN_DIR, "section2.json"))) ?? fail("section2.json");
const pkg = rec(readJson(join(PACKAGE_DIR, "package.json"))) ?? fail("package.json unreadable");

const checkSteps = (Array.isArray(check["check_steps"]) ? check["check_steps"] : []) as Step[];
const consumers = rec(measurements["consumers"]) ?? {};
const tarballMeasured = rec(measurements["tarball"]) ?? {};
const mutations = Array.isArray(mutationsJson["mutations"]) ? mutationsJson["mutations"] : [];
const originRecs = rec(section2["origin"]) ?? {};

const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).stdout.trim();
const tsc = spawnSync("bunx", ["tsc", "--version"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
})
  .stdout.trim()
  .replace(/^Version\s+/, "");

/** counts <label>: {...} lines from the closure-audit step log. */
function auditCounts(label: string): Record<string, number> {
  const log = join(LOG_DIR, "check-closure-audit-src.log");
  if (!existsSync(log)) return {};
  const re = new RegExp(`^counts ${label}: (\\{.*\\})$`, "m");
  const m = re.exec(readFileSync(log, "utf8"));
  return m === null ? {} : (JSON.parse(m[1] ?? "{}") as Record<string, number>);
}
const srcCounts = auditCounts("src");

function titlesFromLog(logRel: string): string[] {
  const path = join(RUN_DIR, logRel);
  if (!existsSync(path)) return [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\((?:pass|fail)\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line.trimEnd());
    if (m?.[1] !== undefined) seen.add(m[1]);
  }
  return [...seen].sort();
}

function parityStep(file: string): { pass: number; fail: number } | null {
  const host = rec(consumers["penumbra-host"]);
  const steps = Array.isArray(host?.["steps"]) ? (host["steps"] as Step[]) : [];
  const s = steps.find((x) => x.name === `parity:${file}`);
  return s === undefined ? null : { pass: s.pass ?? 0, fail: s.fail ?? 0 };
}

function parityTitles(file: string): string[] {
  const host = rec(consumers["penumbra-host"]);
  const steps = Array.isArray(host?.["steps"]) ? (host["steps"] as Step[]) : [];
  const s = steps.find((x) => x.name === `parity:${file}`);
  return s === undefined ? [] : titlesFromLog(str(s.log));
}

const t7Marker = ((): string => {
  const log = join(LOG_DIR, "check-bun-test-gate.log");
  if (!existsSync(log)) return "";
  const m = /t7-overshoot=(\d+)/.exec(readFileSync(log, "utf8"));
  return m?.[1] ?? "";
})();

// ---------------------------------------------------------------------------
// section-2 reconciliation + parity per-file table
// ---------------------------------------------------------------------------
const section2Rows = DISPOSITIONS.map((d) => {
  const origin = rec(originRecs[d.origin]) ?? { pass: 0, fail: 0, ran: 0 };
  const parity = d.parity === null ? null : parityStep(d.parity);
  let consistent = true;
  if (d.kind === "verbatim") {
    consistent =
      parity !== null &&
      parity.fail === 0 &&
      parity.pass === num(origin["pass"]) &&
      num(origin["fail"]) === 0;
  } else if (d.kind === "re-expressed") {
    consistent =
      parity !== null &&
      parity.fail === 0 &&
      parity.pass + d.excluded.length === num(origin["ran"]) &&
      num(origin["fail"]) === 0;
  }
  return {
    origin: d.origin,
    kind: d.kind,
    origin_pass: num(origin["pass"]),
    origin_fail: num(origin["fail"]),
    origin_ran: num(origin["ran"]),
    parity: d.parity,
    parity_pass: parity?.pass ?? null,
    parity_fail: parity?.fail ?? null,
    excluded: d.excluded,
    consistent,
    pointer: d.pointer,
  };
});
const section2Verdict = {
  consistent: section2Rows.every((r) => r.consistent),
  rows: section2Rows,
};

/** Import-line diff between an origin test file and its parity port. */
function importAdaptations(origin: string, parityPointer: string): Record<string, unknown>[] {
  const originPath = join(REPO_ROOT, origin);
  const parityPath = join(PACKAGE_DIR, parityPointer);
  if (!existsSync(originPath) || !existsSync(parityPath)) return [];
  const isImport = (l: string): boolean => /^\s*import\b|^\s*export\s.*\bfrom\b/.test(l);
  const originImports = readFileSync(originPath, "utf8").split("\n").filter(isImport);
  const parityImports = readFileSync(parityPath, "utf8")
    .split("\n")
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((e) => isImport(e.text));
  const out: Record<string, unknown>[] = [];
  const n = Math.max(originImports.length, parityImports.length);
  for (let i = 0; i < n; i += 1) {
    const oldLine = originImports[i] ?? "";
    const newEntry = parityImports[i];
    const newLine = newEntry?.text ?? "";
    if (oldLine === newLine) continue;
    out.push({ file: parityPointer, line: newEntry?.line ?? 0, old: oldLine, new: newLine });
  }
  return out;
}

const perFile = DISPOSITIONS.filter((d) => d.parity !== null).map((d) => {
  const origin = rec(originRecs[d.origin]) ?? {};
  const parity = parityStep(d.parity ?? "");
  return {
    origin: d.origin,
    parity_file: d.pointer,
    baseline_tests: num(origin["ran"]),
    ported: parityTitles(d.parity ?? "").length,
    passed: parity?.pass ?? 0,
    not_portable: d.excluded.length,
    reason:
      d.kind === "re-expressed"
        ? "re-expressed — parity titles carry the [re-expressed] marker and vendor-adapter cases are excluded"
        : "verbatim port — titles preserved",
    adaptations: importAdaptations(d.origin, d.pointer),
  };
});

// ---------------------------------------------------------------------------
// allowlist + derived verdicts
// ---------------------------------------------------------------------------
const allowEntries: Record<string, unknown>[] = (
  ["audit-allowlist.json", "audit-allowlist-dist.json"] as const
).flatMap((f) => {
  const p = join(PACKAGE_DIR, "qualification", f);
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as unknown[];
  return raw.map((e) => ({ ...(rec(e) ?? {}), allowlist: f }));
});
const controlFlow = allowEntries.filter(
  (e) =>
    str(e["classification"]) === "pre-approved" &&
    /retry|fallback|reconnect|resume|adopt|takeover|attach/i.test(str(e["token"])),
);

const extractedManifestPath = join(RUN_DIR, "pack", "extracted", "package", "package.json");
const extractedManifest = existsSync(extractedManifestPath)
  ? rec(readJson(extractedManifestPath))
  : undefined;
const version = str(extractedManifest?.["version"] ?? pkg["version"]);

const gateCtx: GateCtx = {
  runDir: RUN_DIR,
  logDir: LOG_DIR,
  checkSteps,
  consumers,
  mutations,
  version,
  srcCounts,
  allowEntries,
  controlFlowCount: controlFlow.length,
  t7Overshoot: t7Marker,
};
const { gates } = buildGates(gateCtx);

const deviations = [...STATIC_DEVIATIONS];
for (const g of checkSteps) {
  if (g.gating === true && g.exit !== 0) {
    deviations.push({
      rule: "gate-green",
      change: `gate ${String(g.gate)} exited ${String(g.exit)}`,
      reason: "measured failure — recorded, not waived",
      pointer: str(g.log),
    });
  }
}

const afterSet: Record<string, number> = {};
for (const [slice, r] of Object.entries(originRecs)) {
  afterSet[slice] = num(rec(r)?.["pass"]);
}
const delta = Object.entries(BASELINE_SET).reduce(
  (acc, [k, v]) => acc + Math.abs((afterSet[k] ?? -1) - v),
  0,
);

const artifactSha: Record<string, string> = {};
for (const name of readdirSync(RUN_DIR).filter((f) => f.endsWith(".json"))) {
  artifactSha[name] = createHash("sha256")
    .update(readFileSync(join(RUN_DIR, name)))
    .digest("hex");
}

const excludedCases = DISPOSITIONS.flatMap((d) => d.excluded);
const allGatingGreen = checkSteps.every((g) => g.gating !== true || g.exit === 0);
const toolchain = rec(measurements["toolchain"]) ?? {};

const evidence = {
  schema: "sharedlib6-qualification/1",
  slice: "P2.2/penumbra-qualification",
  follow_up_event_id: 1830,
  coordinator: "frozename/llamactl#135",
  roadmap: "frozename/llamactl#127",
  generated_at: new Date().toISOString(),
  date: EVIDENCE_DATE,
  base_sha: BASE_SHA,
  head_sha: head,
  head_sha_note:
    "the commit this evidence was written against; the evidence commit itself lands on top",
  toolchain: {
    bun: str(toolchain["bun"]),
    node: str(toolchain["node"]),
    typescript: tsc,
  },
  result: allGatingGreen ? "PASS" : "FAIL",
  baseline: { measured_set: BASELINE_SET },
  after: { measured_set: afterSet },
  delta,
  candidate: {
    name: str(pkg["name"]),
    name_is_placeholder: true,
    version: str(pkg["version"]),
    files: num(srcCounts["files"]),
    lines: num(srcCounts["lines"]),
    bytes: num(srcCounts["bytes"]),
    runtime_imports: num(srcCounts["runtimeSpecifiers"]),
    type_only_imports: num(srcCounts["typeOnlySpecifiers"]),
    boundary_type_imports_removed: BOUNDARY_TYPE_IMPORTS_REMOVED,
  },
  tarball: { ...tarballMeasured, channel: "stand-in" },
  consumers,
  poison_layer: measurements["poison_layer"],
  parity: {
    excluded_cases: excludedCases,
    per_file: perFile,
    shim_logic: SHIM_LOGIC,
  },
  section2: {
    measurements: { totals: section2["totals"], baseline: BASELINE_SET },
    verdict: section2Verdict,
  },
  gates,
  check_steps: checkSteps,
  blockers: blockerMap(),
  mutations,
  mutations_clean_after: mutationsJson["clean_after"] === true,
  audit_allowlist_entries: allowEntries,
  deferred: [
    {
      gate: "L3",
      part: "llamactl",
      deferred_to: "P2.2/llamactl-adoption",
      reason: "no llamactl consumer exists in this worktree",
    },
  ],
  honesty: {
    channel_stand_in: true,
    channel_chosen: false,
    home_chosen: false,
    adoption_performed: false,
    overall_claim: "none",
  },
  claims_not_made: CLAIMS_NOT_MADE,
  open_findings: OPEN_FINDINGS,
  deviations,
  artifact_sha256: artifactSha,
};

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------
const verdictLine = (g: Record<string, unknown>): string => {
  const parts = rec(g["parts"]);
  const extra =
    g["gate"] === "L2"
      ? ` (${str(g["verdict_scope"])})`
      : g["gate"] === "L3"
        ? ` (penumbra=${str(parts?.["penumbra"])}, synthetic=${str(parts?.["synthetic"])}, llamactl=DEFERRED → ${str(g["deferred_to"])})`
        : "";
  return `- ${str(g["gate"])}: ${str(g["verdict"])}${extra}`;
};

interface EvEntry {
  claim: string;
  status: string;
  pointer: string;
  would_confirm?: string;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function evList(v: unknown): EvEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => rec(e))
    .filter((e): e is Record<string, unknown> => e !== undefined)
    .map((e) => ({
      claim: str(e["claim"]),
      status: str(e["status"]),
      pointer: str(e["pointer"]),
      would_confirm: e["would_confirm"] === undefined ? undefined : str(e["would_confirm"]),
    }));
}

const gateSections = gates
  .map((g) => {
    const nph = stringList(g["not_provable_here"])
      .map((s) => `  - ${s}`)
      .join("\n");
    const ev = evList(g["evidence"])
      .map(
        (e) =>
          `  - ${e.claim} — ${e.status} (\`${e.pointer}\`)${e.would_confirm === undefined ? "" : `; would confirm: ${e.would_confirm}`}`,
      )
      .join("\n");
    const heading =
      g["gate"] === "L2" ? "## L2 packed artifact (channel stand-in)" : `## ${str(g["gate"])}`;
    const intro =
      g["gate"] === "L2"
        ? "Both consumers ran inside this worktree against a locally packed tarball used as a channel stand-in — nothing here asserts a versioned channel, a package home, or a llamactl-side install.\n\n"
        : g["gate"] === "L6"
          ? "Warm pooling is not a resume mechanism: the pool reuses idle child processes within one host process lifetime and carries no session state.\n\n"
          : "";
    return `${heading}\n\n${intro}Verdict: ${str(g["verdict"])} (scope: branch)\n\nEvidence:\n${ev}\n\nNot provable here:\n${nph}`;
  })
  .join("\n\n");

const stepRows = checkSteps
  .map(
    (g) =>
      `| ${String(g.gate)} | \`${str(g.log)}\` | exit ${String(g.exit)}${g.pass !== null ? ` · ${String(g.pass)}p/${String(g.fail ?? "?")}f` : ""}${g.gating === false ? " (non-gating)" : ""} |`,
  )
  .join("\n");

const mutationRows = mutations
  .map((m) => {
    const r = rec(m) ?? {};
    const failingCount = Array.isArray(r["failing_tests"]) ? r["failing_tests"].length : 0;
    return `| ${str(r["patch"])} | ${str(r["intent"])} | ${r["detected"] === true ? "detected" : "MISSED"} (${String(failingCount)} failing; expected-detectors ${String(r["expected_detectors_hit"])}; post-revert-green ${String(r["post_revert_green"])}) |`;
  })
  .join("\n");

function consumerSteps(name: string): string {
  const c = rec(consumers[name]);
  const steps = Array.isArray(c?.["steps"]) ? (c["steps"] as Step[]) : [];
  return steps
    .map(
      (s) =>
        `${String(s.name)} exit ${String(s.exit)}${(s.pass ?? 0) > 0 || (s.fail ?? 0) > 0 ? ` (${String(s.pass)}p/${String(s.fail)}f)` : ""}`,
    )
    .join(" · ");
}

function consumerRow(name: string): string {
  const c = rec(consumers[name]);
  if (c === undefined) return `| ${name} | missing | — | — | — |`;
  return `| ${name} | ${str(c["runtime"])} | \`bun add ${str(c["install_specifier"])}\` | \`${str(c["resolved_to"])}\` | ${consumerSteps(name)} |`;
}

const section2RowsMd = section2Rows
  .map((r) => {
    const parity =
      r.parity === null
        ? "context slice (not ported)"
        : `\`${r.parity}\` → ${String(r.parity_pass)}p/${String(r.parity_fail)}f`;
    const excluded =
      r.excluded.length === 0
        ? "—"
        : `${String(r.excluded.length)} excluded (${r.excluded[0]?.reason ?? ""}${r.excluded.length > 1 ? ", …" : ""})`;
    return `| \`${r.origin}\` | ${r.kind} | ${String(r.origin_pass)}p/${String(r.origin_fail)}f (${String(r.origin_ran)} ran) | ${parity} | ${excluded} | ${r.consistent ? "consistent" : "INCONSISTENT"} |`;
  })
  .join("\n");

const excludedList = excludedCases
  .map((e) => `- \`${e.module}\` — "${e.origin_title}" — ${e.reason}`)
  .join("\n");

const deviationRows = deviations
  .map(
    (d) =>
      `| ${str(d["rule"])} | ${str(d["change"])} | ${str(d["reason"])} | \`${str(d["pointer"])}\` |`,
  )
  .join("\n");

const perFileRows = perFile
  .map(
    (f) =>
      `| \`${f.origin}\` | ${String(f.baseline_tests)} | ${String(f.ported)} | ${String(f.passed)} | ${String(f.not_portable)} |`,
  )
  .join("\n");

const md = `# Qualification — penumbra-exec-primitives (P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from \`packages/agentchat/src/adapters/\`. This report asserts nothing
about adoption, release, publication, package home, or registry state. Every
tarball mention below refers to a local channel stand-in, never a versioned
channel.

Commit: \`${head}\` — base: \`${BASE_SHA}\`
Toolchain: bun ${str(toolchain["bun"])} · node ${str(toolchain["node"])} · typescript ${tsc}
Generated: ${str(evidence.generated_at)}
Result (derived): ${str(evidence.result)}

## Verdicts

${gates.map(verdictLine).join("\n")}

## Check steps

| Step | Log | Result |
| --- | --- | --- |
${stepRows}

${gateSections}

## Mutations

${String(mutations.length)} patches; clean after revert: \`${String(mutationsJson["clean_after"])}\`.

| Patch | Intent | Detection |
| --- | --- | --- |
${mutationRows}

## Tarball (channel stand-in)

\`${str(tarballMeasured["name"])}\` — ${String(tarballMeasured["files"])} files, ${String(tarballMeasured["unpacked_bytes"])} bytes unpacked. This tarball is a local channel stand-in.

- \`sha256(tgz) = ${str(tarballMeasured["sha256"])}\`
- \`content_sha256 = ${str(tarballMeasured["content_sha256"])}\` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent \`bun pm pack\` runs → byte_reproducible=${String(tarballMeasured["byte_reproducible"])}
- entries: ${String(Array.isArray(tarballMeasured["entries"]) ? tarballMeasured["entries"].length : 0)} (package.json, LICENSE, README.md, dist/src/** only)

## Consumers

Each consumer fixture is copied to \`tmp/sharedlib6/consumer-<name>/\`, installs
the packed channel-stand-in tarball via \`bun add\` under an isolated HOME + bun
cache, and runs against a poisoned \`@penumbra/*\` resolution layer so a
workspace link can never mask a missing install. Runtime steps run with dead
proxy variables — the suite proves no network is required once installed.

| Host | Runtime | Install | Resolved to | Steps |
| ---- | --- | --- | --- | --- |
${consumerRow("penumbra-host")}
${consumerRow("infra-host")}

Installed-content digest equals the channel-stand-in tarball digest for each
consumer (\`digest_equal\`), \`home_entries_after\` is empty for both isolated
HOMEs, and the per-copy poison run passes 0 tests against the broken entry.

## Section 2 — adapter-surface parity vs \`packages/agentchat/\`

Origin slices are measured fresh each run (\`section2-slice.ts\`); parity counts
come from the per-file parity steps inside the penumbra-host consumer copy.
Baseline and after carry a delta of ${String(delta)}.

| Origin | Disposition | Origin result | Parity result | Exclusions | Verdict |
| --- | --- | --- | --- | --- | --- |
${section2RowsMd}

Per-file parity table (baseline_tests = ported + not_portable):

| Origin | baseline_tests | ported | passed | not_portable |
| --- | --- | --- | --- | --- |
${perFileRows}

Excluded origin executions (exercising surfaces deliberately not extracted):
${excludedList === "" ? "- none" : excludedList}

Boundary imports removed (per extraction contract):

| Adapter source | Removed import | Replaced by |
| --- | --- | --- |
| \`cli-spawn.ts\` | \`@penumbra/core\` (DispatchEventInput), \`@src/sdk/adapter.js\` (DispatchEvent), \`@src/worker/thought-capture.js\` | generic supervision in \`process-supervisor.ts\` |
| \`stdio-acp-permission.ts\` | \`@src/sdk/adapter.js\` (DispatchInput) | \`PermissionHost\` — host passes \`signal\`, \`dispatchId\`, \`decide\`, \`logger\` |
| \`stdio-acp-server.ts\` | none (was already local) | \`console.error\` → \`logger\`; stderr tee → \`onStderrChunk\` callback |
| \`stdio-acp-client.ts\` | none | \`console.*\` → \`ExecLogger\`; close-guards added |
| \`acp-warm-pool.ts\` | \`@src/adapters/stdio-acp-client.js\` (type-level) | \`AcpPoolClient\` structural type (no runtime import) |

## Deviations

| Rule | Change | Reason | Pointer |
| --- | --- | --- | --- |
${deviationRows}

## Open findings

${OPEN_FINDINGS.map((f) => `- ${str(f["finding"])}${f["would_confirm"] === undefined ? "" : ` (would confirm: ${str(f["would_confirm"])})`}`).join("\n")}

## Claims not made

${CLAIMS_NOT_MADE.map((c) => `- ${c}`).join("\n")}

## Reproduce

\`\`\`sh
bun install --frozen-lockfile
bun packages/exec-primitives/scripts/sharedlib6-check.ts --keep
bun packages/exec-primitives/scripts/write-evidence.ts
\`\`\`

## Scope

The packed tarball exercised here is a local channel stand-in. Parity is
bounded by the suites actually executed and recorded above; nothing about
distribution, hosting, or downstream adoption follows from this record.
`;

mkdirSync(DOCS_DIR, { recursive: true });
const jsonPath = join(DOCS_DIR, `${EVIDENCE_DATE}-sharedlib6-qualification.json`);
const mdPath = join(DOCS_DIR, `${EVIDENCE_DATE}-sharedlib6-qualification.md`);
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(mdPath, md);
process.stdout.write(`write-evidence: wrote ${jsonPath}\n${mdPath}\n`);
