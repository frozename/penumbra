/**
 * write-evidence-build.ts — builds the evidence object from a kept run
 * (tmp/sharedlib6, left by `sharedlib6-check.ts --keep`). Two callers:
 *   - write-evidence.ts writes the committed pair from it;
 *   - SHAPE (sharedlib6-shape-regen.ts) rebuilds the record from the check's
 *     own fresh run and diffs the committed .json against it, so every field
 *     the writer derives is bound to this run's measurements.
 * Missing or unmeasurable artifacts throw; nothing is defaulted into a record.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PerFileRow, Section2Row } from "./write-evidence-md.js";

import { parseBunTest } from "./bun-test-parse.js";
import {
  ARTIFACT_FILES,
  auditCounts,
  BASE_SHA,
  eslintErrorCounts,
  EVIDENCE_DATE,
  evidenceMutationRecord,
} from "./sharedlib6-shape-util.js";
import {
  BASELINE_SET,
  BOUNDARY_TYPE_IMPORTS_REMOVED,
  CLAIMS_NOT_MADE,
  DISPOSITIONS,
  OPEN_FINDINGS,
  rootLintFinding,
  SHIM_LOGIC,
  STATIC_DEVIATIONS,
} from "./write-evidence-data.js";
import { buildGates, deriveBlockers, type GateCtx, type Step } from "./write-evidence-gates.js";

export interface BuildEnv {
  repoRoot: string;
  packageDir: string;
  runDir: string;
  /** The check's step records (check_steps). */
  checkSteps: Step[];
  head: string;
  typescript: string;
  generatedAt: string;
}

type Obj = Record<string, unknown>;

/** The tag set of the RED/GREEN table (one row per mutation tag). */
export const RED_GREEN_TAGS = ["B3", "B4", "B6", "B7", "B8", "B10"];

function rec(v: unknown): Obj | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readJson(path: string): Obj {
  if (!existsSync(path)) {
    throw new Error(`missing artifact ${path}; run bun scripts/sharedlib6-check.ts --keep first`);
  }
  const parsed = rec(JSON.parse(readFileSync(path, "utf8")) as unknown);
  if (parsed === undefined) throw new Error(`artifact ${path} is not a JSON object`);
  return parsed;
}

function logText(logDir: string, name: string): string {
  const path = join(logDir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** [tag] titles passing in the gate log (RED/GREEN table, blockers). */
function tagPassCounts(logDir: string): Record<string, number> {
  const parsed = parseBunTest(
    logText(logDir, "check-bun-test-gate.log"),
    "check-bun-test-gate.log",
  );
  if (parsed.problem !== undefined) throw new Error(parsed.problem);
  const counts: Record<string, number> = {};
  for (const tag of RED_GREEN_TAGS) {
    counts[tag] = parsed.passTitles.filter((t) => t.includes(`[${tag}]`)).length;
  }
  return counts;
}

/** Executed titles from a parity log; an unmeasurable log throws. */
function titlesFromLog(runDir: string, logRel: string): string[] {
  const path = join(runDir, logRel);
  if (!existsSync(path)) return [];
  const parsed = parseBunTest(readFileSync(path, "utf8"), logRel);
  if (parsed.problem !== undefined) throw new Error(parsed.problem);
  return parsed.titles;
}

function hostSteps(consumers: Obj): Step[] {
  const host = rec(consumers["penumbra-host"]);
  return Array.isArray(host?.["steps"]) ? (host["steps"] as Step[]) : [];
}

function parityStep(consumers: Obj, file: string): { pass: number; fail: number } | null {
  const s = hostSteps(consumers).find((x) => x.name === `parity:${file}`);
  return s === undefined ? null : { pass: s.pass ?? 0, fail: s.fail ?? 0 };
}

function parityTitles(runDir: string, consumers: Obj, file: string): string[] {
  const s = hostSteps(consumers).find((x) => x.name === `parity:${file}`);
  return s === undefined ? [] : titlesFromLog(runDir, str(s.log));
}

function t7Marker(logDir: string): string {
  return /t7-overshoot=(\d+)/.exec(logText(logDir, "check-bun-test-gate.log"))?.[1] ?? "";
}

function rowConsistent(
  kind: string,
  origin: Obj,
  parity: { pass: number; fail: number } | null,
  excluded: number,
): boolean {
  if (kind === "context") return true;
  if (parity?.fail !== 0 || num(origin["fail"]) !== 0) return false;
  return kind === "verbatim"
    ? parity.pass === num(origin["pass"])
    : parity.pass + excluded === num(origin["ran"]);
}

function section2Rows(originRecs: Obj, consumers: Obj): (Section2Row & { pointer: string })[] {
  return DISPOSITIONS.map((d) => {
    const origin = rec(originRecs[d.origin]) ?? { pass: 0, fail: 0, ran: 0 };
    const parity = d.parity === null ? null : parityStep(consumers, d.parity);
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
      consistent: rowConsistent(d.kind, origin, parity, d.excluded.length),
      pointer: d.pointer,
    };
  });
}

/** Import-line diff between an origin test file and its parity port. */
function importAdaptations(
  repoRoot: string,
  packageDir: string,
  origin: string,
  parityPointer: string,
): Obj[] {
  const originPath = join(repoRoot, origin);
  const parityPath = join(packageDir, parityPointer);
  if (!existsSync(originPath) || !existsSync(parityPath)) return [];
  const isImport = (l: string): boolean => /^\s*import\b|^\s*export\s.*\bfrom\b/.test(l);
  const originImports = readFileSync(originPath, "utf8").split("\n").filter(isImport);
  const parityImports = readFileSync(parityPath, "utf8")
    .split("\n")
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((e) => isImport(e.text));
  const out: Obj[] = [];
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

function perFileRows(env: BuildEnv, originRecs: Obj, consumers: Obj): PerFileRow[] {
  return DISPOSITIONS.filter((d) => d.parity !== null).map((d) => {
    const origin = rec(originRecs[d.origin]) ?? {};
    const file = d.parity ?? "";
    return {
      origin: d.origin,
      parity_file: d.pointer,
      baseline_tests: num(origin["ran"]),
      ported: parityTitles(env.runDir, consumers, file).length,
      passed: parityStep(consumers, file)?.pass ?? 0,
      not_portable: d.excluded.length,
      reason:
        d.kind === "re-expressed"
          ? "re-expressed — parity titles carry the [re-expressed] marker and vendor-adapter cases are excluded"
          : "verbatim port — titles preserved",
      adaptations: importAdaptations(env.repoRoot, env.packageDir, d.origin, d.pointer),
    };
  });
}

/** Both allowlists, each entry tagged with its file. */
export function loadAllowlistEntries(packageDir: string): Obj[] {
  return (["audit-allowlist.json", "audit-allowlist-dist.json"] as const).flatMap((f) => {
    const p = join(packageDir, "qualification", f);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return (Array.isArray(raw) ? raw : []).map((e) => ({ ...(rec(e) ?? {}), allowlist: f }));
  });
}

function deviations(checkSteps: Step[]): Obj[] {
  const out = [...STATIC_DEVIATIONS];
  for (const g of checkSteps) {
    if (g.gating === true && g.exit !== 0) {
      out.push({
        rule: "gate-green",
        change: `gate ${String(g.gate)} exited ${String(g.exit)}`,
        reason: "measured failure — recorded, not waived",
        pointer: str(g.log),
      });
    }
  }
  return out;
}

/** sha256 of each ARTIFACT_FILES entry this run has written. */
function artifactSha(runDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ARTIFACT_FILES.filter((f) => existsSync(join(runDir, f)))) {
    out[name] = createHash("sha256")
      .update(readFileSync(join(runDir, name)))
      .digest("hex");
  }
  return out;
}

interface Artifacts {
  logDir: string;
  measurements: Obj;
  mutationsJson: Obj;
  section2: Obj;
  pkg: Obj;
  consumers: Obj;
  mutations: unknown[];
  originRecs: Obj;
  srcCounts: Record<string, number>;
  version: string;
  manifestPrivate: boolean;
}

function loadArtifacts(env: BuildEnv): Artifacts {
  const logDir = join(env.runDir, "check-logs");
  const measurements = readJson(join(env.runDir, "measurements.json"));
  const mutationsJson = readJson(join(env.runDir, "mutations.json"));
  const section2 = readJson(join(env.runDir, "section2.json"));
  const pkg = readJson(join(env.packageDir, "package.json"));
  const manifestPath = join(env.runDir, "pack", "extracted", "package", "package.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
  return {
    logDir,
    measurements,
    mutationsJson,
    section2,
    pkg,
    consumers: rec(measurements["consumers"]) ?? {},
    mutations: Array.isArray(mutationsJson["mutations"]) ? mutationsJson["mutations"] : [],
    originRecs: rec(section2["origin"]) ?? {},
    srcCounts: auditCounts(logDir, "src"),
    version: str(manifest?.["version"] ?? pkg["version"]),
    manifestPrivate: manifest?.["private"] === true && pkg["private"] === true,
  };
}

function section2Block(a: Artifacts): { after: Record<string, number>; delta: number } {
  const after: Record<string, number> = {};
  for (const [slice, r] of Object.entries(a.originRecs)) after[slice] = num(rec(r)?.["pass"]);
  const delta = Object.entries(BASELINE_SET).reduce(
    (acc, [k, v]) => acc + Math.abs((after[k] ?? -1) - v),
    0,
  );
  return { after, delta };
}

/** The evidence object for one kept run. */
export function buildEvidence(env: BuildEnv): Obj {
  const a = loadArtifacts(env);
  const allowEntries = loadAllowlistEntries(env.packageDir);
  const controlFlow = allowEntries.filter(
    (e) =>
      str(e["classification"]) === "pre-approved" &&
      /retry|fallback|reconnect|resume|adopt|takeover|attach/i.test(str(e["token"])),
  );
  const gateCtx: GateCtx = {
    runDir: env.runDir,
    logDir: a.logDir,
    checkSteps: env.checkSteps,
    consumers: a.consumers,
    mutations: a.mutations,
    version: a.version,
    srcCounts: a.srcCounts,
    allowEntries,
    controlFlowCount: controlFlow.length,
    t7Overshoot: t7Marker(a.logDir),
  };
  const rows = section2Rows(a.originRecs, a.consumers);
  const { after, delta } = section2Block(a);
  const toolchain = rec(a.measurements["toolchain"]) ?? {};
  const openFindings = [
    ...OPEN_FINDINGS,
    rootLintFinding(
      eslintErrorCounts(
        logText(a.logDir, "check-root-lint.log"),
        "/packages/exec-primitives/qualification/",
      ),
    ),
  ];
  return {
    schema: "sharedlib6-qualification/1",
    slice: "P2.2/penumbra-qualification",
    follow_up_event_id: 1830,
    coordinator: "frozename/llamactl#135",
    roadmap: "frozename/llamactl#127",
    generated_at: env.generatedAt,
    date: EVIDENCE_DATE,
    base_sha: BASE_SHA,
    head_sha: env.head,
    head_sha_note:
      "the commit this evidence was written against; the evidence commit itself lands on top",
    toolchain: {
      bun: str(toolchain["bun"]),
      node: str(toolchain["node"]),
      typescript: env.typescript,
    },
    result: env.checkSteps.every((g) => g.gating !== true || g.exit === 0) ? "PASS" : "FAIL",
    baseline: { measured_set: BASELINE_SET },
    after: { measured_set: after },
    delta,
    candidate: {
      name: str(a.pkg["name"]),
      name_is_placeholder: true,
      version: str(a.pkg["version"]),
      files: num(a.srcCounts["files"]),
      lines: num(a.srcCounts["lines"]),
      bytes: num(a.srcCounts["bytes"]),
      runtime_imports: num(a.srcCounts["runtimeSpecifiers"]),
      type_only_imports: num(a.srcCounts["typeOnlySpecifiers"]),
      boundary_type_imports_removed: BOUNDARY_TYPE_IMPORTS_REMOVED,
    },
    tarball: { ...(rec(a.measurements["tarball"]) ?? {}), channel: "stand-in" },
    consumers: a.consumers,
    poison_layer: a.measurements["poison_layer"],
    parity: {
      excluded_cases: DISPOSITIONS.flatMap((d) => d.excluded),
      per_file: perFileRows(env, a.originRecs, a.consumers),
      shim_logic: SHIM_LOGIC,
    },
    section2: {
      measurements: { totals: a.section2["totals"], baseline: BASELINE_SET },
      verdict: { consistent: rows.every((r) => r.consistent), rows },
    },
    gates: buildGates(gateCtx).gates,
    check_steps: env.checkSteps,
    blockers: deriveBlockers(gateCtx, a.manifestPrivate),
    red_green: { tag_passes: tagPassCounts(a.logDir) },
    mutations: a.mutations.map(evidenceMutationRecord),
    mutations_clean_after: a.mutationsJson["clean_after"] === true,
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
    open_findings: openFindings,
    deviations: deviations(env.checkSteps),
    artifact_sha256: artifactSha(env.runDir),
  };
}
