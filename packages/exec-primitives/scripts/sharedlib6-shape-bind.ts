/**
 * sharedlib6-shape-bind.ts — SHAPE bindings from evidence fields to this
 * run's fresh measurements. Each binding recomputes the field from the run's
 * own artifacts (measurements.json, mutations.json, the step records and step
 * logs, the allowlists, the extracted manifest) and reports every mismatch:
 *   - gates[].measurements for L1..L6;
 *   - parity.per_file baseline_tests / ported / passed / not_portable;
 *   - candidate.* against the closure-audit `counts src` line;
 *   - the required open_findings entries (and the root-lint counts);
 *   - claim placement in the .json and the channel stand-in label on every
 *     tarball mention in the prose of both files.
 * sharedlib6-shape-probes.ts pins each binding with an edit that must fail.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { consumerStepFailures } from "./sharedlib6-shape-measured.js";
import {
  auditCounts,
  claimRe,
  CONTROL_FLOW_TOKEN_RE,
  deepEqual,
  eslintErrorCounts,
  FORBIDDEN_CLAIMS,
  type GateRec,
  loadAllowEntries,
  num,
  readJsonFile,
  rec,
  REQUIRED_OPEN_FINDINGS,
  SECTION2_BASELINE,
  type ShapeContext,
  str,
  titlesFromLog,
} from "./sharedlib6-shape-util.js";

type Ev = Record<string, unknown>;

function stepOf(ctx: ShapeContext, name: string): GateRec | undefined {
  return ctx.gates.find((g) => g.gate === name);
}

function consumerMeasurement(v: unknown): Ev {
  const c = rec(v) ?? {};
  const steps = Array.isArray(c["steps"]) ? c["steps"] : [];
  return {
    steps: steps.length,
    all_green: steps.every((s) => rec(s)?.["exit"] === 0 && rec(s)?.["fail"] === 0),
    poison_pass: rec(c["poison_run"])?.["pass"],
    guard_exit: rec(c["guard"])?.["exit"],
    digest_equal: c["digest_equal"],
  };
}

/** The T7 marker the [B10] output-limit test prints into the gate log. */
export function t7Overshoot(logDir: string): number | null {
  const path = join(logDir, "check-bun-test-gate.log");
  const m = existsSync(path) ? /t7-overshoot=(\d+)/.exec(readFileSync(path, "utf8")) : null;
  return m?.[1] === undefined ? null : Number(m[1]);
}

function allowlistCounts(ctx: ShapeContext): Ev {
  const files = ["audit-allowlist.json", "audit-allowlist-dist.json"].map((f) =>
    join(ctx.packageDir, "qualification", f),
  );
  const raw = files.flatMap((p): unknown[] => {
    const r = readJsonFile(p);
    return Array.isArray(r) ? (r as unknown[]) : [];
  });
  const control = files
    .flatMap(loadAllowEntries)
    .filter((e) => e.classification === "pre-approved" && CONTROL_FLOW_TOKEN_RE.test(e.token));
  return { allowlist_entries: raw.length, control_flow_entries: control.length };
}

function extractedVersion(ctx: ShapeContext): string {
  const manifest = rec(
    readJsonFile(join(ctx.runDir, "pack", "extracted", "package", "package.json")),
  );
  const pkg = rec(readJsonFile(join(ctx.packageDir, "package.json")));
  return str(manifest?.["version"] ?? pkg?.["version"]);
}

function detectedMutations(ctx: ShapeContext): number {
  const list = rec(readJsonFile(ctx.mutations))?.["mutations"];
  return Array.isArray(list) ? list.filter((m) => rec(m)?.["detected"] === true).length : 0;
}

/** The measurements block each gate must carry, recomputed from this run.
 * L4's t7_overshoot_bytes is compared separately (see t7Reasons). */
function expectedGateMeasurements(ctx: ShapeContext, measured: Ev): Ev[] {
  const consumers = rec(measured["consumers"]) ?? {};
  const part = (name: string): string =>
    consumerStepFailures({ [name]: consumers[name] }).length === 0 ? "PASS" : "FAIL";
  const tg = stepOf(ctx, "test-gate");
  return [
    auditCounts(ctx.logDir, "src"),
    {
      consumers: Object.fromEntries(
        Object.entries(consumers).map(([k, v]) => [k, consumerMeasurement(v)]),
      ),
    },
    { penumbra: part("penumbra-host"), synthetic: part("infra-host") },
    {
      suite: { pass: tg?.pass ?? null, fail: tg?.fail ?? null },
      mutations_detected: detectedMutations(ctx),
    },
    { version: extractedVersion(ctx), root_lint_exit: stepOf(ctx, "root-lint")?.exit ?? 1 },
    allowlistCounts(ctx),
  ];
}

/** The overshoot varies run to run with pipe chunking (measured over 10 runs:
 * 131072 six times, 196608 four times), so equality would be a coin toss.
 * Bound instead: the evidence carries a positive integer and this run's gate
 * log measured a positive overshoot too. */
function t7Reasons(ctx: ShapeContext, got: unknown): string[] {
  const reasons: string[] = [];
  const value = num(got);
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    reasons.push(
      `gates[L4].measurements.t7_overshoot_bytes ${String(got)} is not a measured positive overshoot`,
    );
  }
  const fresh = t7Overshoot(ctx.logDir);
  if (fresh === null || fresh <= 0) {
    reasons.push(
      "gates[L4].measurements: this run's gate log carries no positive t7-overshoot marker",
    );
  }
  return reasons;
}

export function shapeGateMeasurements(ctx: ShapeContext, evidence: Ev, measured: Ev): string[] {
  const gates = Array.isArray(evidence["gates"]) ? evidence["gates"] : [];
  const want = expectedGateMeasurements(ctx, measured);
  const reasons: string[] = [];
  if (Object.keys(want[0] ?? {}).length === 0) {
    reasons.push("gates[L1].measurements: no `counts src:` line in check-closure-audit-src.log");
  }
  for (const [i, w] of want.entries()) {
    const got = { ...rec(rec(gates[i])?.["measurements"]) };
    if (i === 3) {
      reasons.push(...t7Reasons(ctx, got["t7_overshoot_bytes"]));
      delete got["t7_overshoot_bytes"];
    }
    if (!deepEqual(got, w)) {
      reasons.push(
        `gates[L${String(i + 1)}].measurements ${JSON.stringify(got)} != fresh ${JSON.stringify(w)}`,
      );
    }
  }
  return reasons;
}

// --- parity.per_file ---------------------------------------------------------

const ADAPTER_ORIGINS = new Set(
  Object.keys(SECTION2_BASELINE).filter((k) => k !== "packages/agentchat/test/cli"),
);

function penumbraSteps(measured: Ev): Map<string, Ev> {
  const host = rec(rec(measured["consumers"])?.["penumbra-host"]);
  const steps = Array.isArray(host?.["steps"]) ? host["steps"] : [];
  const out = new Map<string, Ev>();
  for (const s of steps) {
    const sr = rec(s);
    if (sr !== undefined) out.set(str(sr["name"]), sr);
  }
  return out;
}

function perFileExpected(
  ctx: ShapeContext,
  origin: string,
  steps: Map<string, Ev>,
  excluded: unknown[],
  problems: string[],
): Record<string, number | null> {
  const step = steps.get(`parity:${origin.split("/").pop() ?? ""}`);
  const titles = step === undefined ? [] : titlesFromLog(ctx, str(step["log"]), problems);
  return {
    baseline_tests: SECTION2_BASELINE[origin] ?? null,
    ported: step === undefined ? null : titles.length,
    passed: num(step?.["pass"]) ?? null,
    not_portable: excluded.filter((e) => rec(e)?.["module"] === origin).length,
  };
}

function perFileEntryReasons(label: string, f: Ev, want: Record<string, number | null>): string[] {
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    if (f[k] !== v) reasons.push(`${label}.${k} ${String(f[k])} != measured ${String(v)}`);
  }
  if ((want["ported"] ?? 0) + (want["not_portable"] ?? 0) !== want["baseline_tests"]) {
    reasons.push(`${label}: measured ported + not_portable != the section-2 baseline`);
  }
  return reasons;
}

export function shapePerFile(ctx: ShapeContext, evidence: Ev, measured: Ev): string[] {
  const parity = rec(evidence["parity"]);
  const perFile = parity?.["per_file"];
  if (!Array.isArray(perFile)) return ["parity.per_file missing"];
  const excluded = Array.isArray(parity?.["excluded_cases"]) ? parity["excluded_cases"] : [];
  const steps = penumbraSteps(measured);
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of perFile.entries()) {
    const f = rec(entry) ?? {};
    const origin = str(f["origin"]);
    const label = `parity.per_file[${String(i)}]`;
    if (!ADAPTER_ORIGINS.has(origin) || seen.has(origin)) {
      reasons.push(`${label}: origin "${origin}" unknown or repeated`);
      continue;
    }
    seen.add(origin);
    reasons.push(
      ...perFileEntryReasons(label, f, perFileExpected(ctx, origin, steps, excluded, reasons)),
    );
  }
  return reasons;
}

// --- candidate ----------------------------------------------------------------

export function shapeCandidate(ctx: ShapeContext, evidence: Ev): string[] {
  const cand = rec(evidence["candidate"]);
  if (cand === undefined) return ["candidate block missing"];
  const counts = auditCounts(ctx.logDir, "src");
  if (Object.keys(counts).length === 0) {
    return ["candidate: no `counts src:` line in check-closure-audit-src.log"];
  }
  const pkg = rec(readJsonFile(join(ctx.packageDir, "package.json"))) ?? {};
  const want: Ev = {
    name: pkg["name"],
    name_is_placeholder: true,
    version: pkg["version"],
    files: counts["files"],
    lines: counts["lines"],
    bytes: counts["bytes"],
    runtime_imports: counts["runtimeSpecifiers"],
    type_only_imports: counts["typeOnlySpecifiers"],
  };
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    if (cand[k] !== v) reasons.push(`candidate.${k} ${String(cand[k])} != measured ${String(v)}`);
  }
  const removed = cand["boundary_type_imports_removed"];
  if (
    !Array.isArray(removed) ||
    removed.length === 0 ||
    removed.some((r) => ["file", "removed", "replaced_by"].some((k) => str(rec(r)?.[k]) === ""))
  ) {
    reasons.push("candidate.boundary_type_imports_removed[] must name each removed import");
  }
  return reasons;
}

// --- open_findings ------------------------------------------------------------

function findingShapeReasons(f: Ev, i: number): string[] {
  const reasons: string[] = [];
  const status = str(f["status"]);
  if (str(f["id"]) === "" || str(f["finding"]) === "" || str(f["pointer"]) === "") {
    reasons.push(`open_findings[${String(i)}] needs id, finding and pointer`);
  }
  if (!["open", "inferred"].includes(status)) {
    reasons.push(`open_findings[${String(i)}] status "${status}" is not open|inferred`);
  }
  if (status === "inferred" && str(f["would_confirm"]) === "") {
    reasons.push(`open_findings[${String(i)}] is inferred without would_confirm`);
  }
  return reasons;
}

function rootLintReasons(ctx: ShapeContext, byId: Map<string, Ev>): string[] {
  const entry = byId.get("root-lint-qualification-errors");
  if (entry === undefined) return [];
  const path = join(ctx.logDir, "check-root-lint.log");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const fresh = eslintErrorCounts(text, "/packages/exec-primitives/qualification/");
  return deepEqual(entry["measured"], fresh)
    ? []
    : [
        `open_findings root-lint-qualification-errors measured ${JSON.stringify(entry["measured"])} != check-root-lint.log ${JSON.stringify(fresh)}`,
      ];
}

export function shapeOpenFindings(ctx: ShapeContext, evidence: Ev): string[] {
  const list = evidence["open_findings"];
  if (!Array.isArray(list)) return ["open_findings[] missing"];
  const reasons: string[] = [];
  const byId = new Map<string, Ev>();
  for (const [i, raw] of list.entries()) {
    const f = rec(raw) ?? {};
    reasons.push(...findingShapeReasons(f, i));
    const id = str(f["id"]);
    if (byId.has(id)) reasons.push(`open_findings id ${id} repeated`);
    byId.set(id, f);
  }
  for (const id of REQUIRED_OPEN_FINDINGS) {
    if (!byId.has(id)) reasons.push(`open_findings missing required entry ${id}`);
  }
  reasons.push(...rootLintReasons(ctx, byId));
  return reasons;
}

// --- claim placement and stand-in labels -----------------------------------------

/** Every string leaf (and key) under `value`, with its dotted path. */
function stringLeaves(value: unknown, path: string, out: [string, string, string][]): void {
  const key =
    path
      .split(".")
      .pop()
      ?.replace(/\[\d+\]$/, "") ?? "";
  if (typeof value === "string") {
    out.push([path, key, value]);
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) stringLeaves(v, `${path}[${String(i)}]`, out);
  } else if (rec(value) !== undefined) {
    for (const [k, v] of Object.entries(value as Ev)) {
      out.push([`${path}.${k}`, "(key)", k]);
      stringLeaves(v, `${path}.${k}`, out);
    }
  }
}

function evidenceLeaves(evidence: Ev, skip: string[]): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const [k, v] of Object.entries(evidence)) {
    if (skip.includes(k)) continue;
    out.push([k, "(key)", k]);
    stringLeaves(v, k, out);
  }
  return out;
}

/** Claim phrases may appear in the .json only inside claims_not_made and honesty. */
export function shapeJsonClaims(evidence: Ev): string[] {
  const reasons: string[] = [];
  for (const [path, , text] of evidenceLeaves(evidence, ["claims_not_made", "honesty"])) {
    for (const claim of FORBIDDEN_CLAIMS) {
      if (claimRe(claim).test(text)) {
        reasons.push(
          `evidence json carries claim "${claim}" at ${path}; claims belong only in claims_not_made and honesty`,
        );
      }
    }
  }
  return reasons;
}

const TARBALL_MENTION_RE = /\btarballs?\b|\bpacked\b|\.tgz\b/i;
const STAND_IN = "channel stand-in";
/** Prose keys: pointers, paths, names and ids are identifiers, not prose. */
const PROSE_KEYS = new Set([
  "claim",
  "not_provable_here",
  "evidence",
  "change",
  "reason",
  "finding",
  "would_confirm",
  "logic",
  "status",
  "head_sha_note",
  "superseded_note",
]);

/** Markdown units: one per table row or list item, one per paragraph; fenced
 * code is skipped and inline code spans are stripped before matching. */
function markdownUnits(md: string): string[] {
  const units: string[] = [];
  let para: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (para.length > 0) units.push(para.join(" "));
    para = [];
  };
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      flush();
    } else if (fenced) {
      continue;
    } else if (line.trim() === "") {
      flush();
    } else if (/^\s*(?:\||- |#)/.test(line)) {
      flush();
      units.push(line);
    } else {
      para.push(line);
    }
  }
  flush();
  return units.map((u) => u.replaceAll(/`[^`]*`/g, "``"));
}

/** Every tarball mention in prose carries the channel stand-in label. */
export function shapeStandInLabels(evidence: Ev, md: string): string[] {
  const reasons: string[] = [];
  for (const [path, key, text] of evidenceLeaves(evidence, [])) {
    if (PROSE_KEYS.has(key) && TARBALL_MENTION_RE.test(text) && !text.includes(STAND_IN)) {
      reasons.push(`unlabelled tarball mention in the .json at ${path} (needs "${STAND_IN}")`);
    }
  }
  for (const unit of markdownUnits(md)) {
    if (TARBALL_MENTION_RE.test(unit) && !unit.includes(STAND_IN)) {
      reasons.push(`unlabelled tarball mention in the .md: ${unit.slice(0, 100)}`);
    }
  }
  return reasons;
}
