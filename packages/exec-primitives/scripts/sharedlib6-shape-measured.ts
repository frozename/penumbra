/**
 * sharedlib6-shape-measured.ts — SHAPE validators that compare the committed
 * evidence against this run's fresh measurements (measurements.json,
 * mutations.json, section2.json, executed parity logs, the extracted tarball
 * and the bun-test-gate log).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBunTest } from "./bun-test-parse.js";
import {
  CONTROL_FLOW_TOKEN_RE,
  deepEqual,
  EXPECTED_EXCLUDED_TITLES,
  leaf,
  loadAllowEntries,
  num,
  readJsonFile,
  rec,
  REEXPRESSED_ORIGINS,
  SECTION2_BASELINE,
  type ShapeContext,
  str,
  titlesFromLog,
  VERBATIM_MAP,
} from "./sharedlib6-shape-util.js";

export function shapeTarball(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  measured: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const ev = rec(evidence["tarball"]);
  const mt = rec(measured["tarball"]);
  if (ev === undefined || mt === undefined) {
    reasons.push("tarball block missing from evidence or measurements");
    return reasons;
  }
  if (ev["channel"] !== "stand-in") reasons.push("tarball.channel != stand-in");
  for (const k of [
    "name",
    "sha256",
    "packed_bytes",
    "unpacked_bytes",
    "files",
    "entries",
    "content_sha256",
    "byte_reproducible",
  ]) {
    if (!deepEqual(ev[k], mt[k])) reasons.push(`tarball.${k} evidence != measurement`);
  }
  if (mt["byte_reproducible"] !== true) {
    reasons.push("repack determinism not measured byte-identical");
  }
  void ctx;
  return reasons;
}

/** Per-consumer measured green rules — the empty record set means green. */
export function consumerStepFailures(recs: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  for (const [name, r] of Object.entries(recs)) {
    const rr = rec(r);
    if (rr === undefined) {
      reasons.push(`${name}: consumer record missing`);
      continue;
    }
    reasons.push(...consumerRecordFailures(name, rr));
  }
  return reasons;
}

function consumerRecordFailures(name: string, rr: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const spec = str(rr["install_specifier"]);
  if (!/^\.\.\/pack\/penumbra-exec-primitives-0\.1\.0\.tgz$/.test(spec)) {
    reasons.push(`${name}: install_specifier ${spec} does not name the tmp pack tarball`);
  }
  if (!deepEqual(rr["home_entries_after"], [])) {
    reasons.push(`${name}: isolated HOME/XDG_CONFIG_HOME not empty after run`);
  }
  if (rr["network_required"] !== true) {
    reasons.push(`${name}: install must record the registry fetch (network_required)`);
  }
  if (!deepEqual(rr["registry_packages"], ["typescript", "@types/node"])) {
    reasons.push(`${name}: registry_packages must record the two devDependencies`);
  }
  if (rec(rr["poison_run"])?.["pass"] !== 0) {
    reasons.push(`${name}: poison run did not zero every test file`);
  }
  if (rec(rr["guard"])?.["exit"] !== 0) {
    reasons.push(`${name}: guard probe did not resolve to the stub`);
  }
  if (rr["digest_equal"] !== true) {
    reasons.push(`${name}: installed content digest != tarball digest`);
  }
  const steps = rr["steps"];
  if (
    !Array.isArray(steps) ||
    steps.some((s) => {
      const sr = rec(s);
      return sr?.["exit"] !== 0 || sr["fail"] !== 0;
    })
  ) {
    reasons.push(`${name}: a consumer step exited non-zero or reported a failure`);
  }
  return reasons;
}

export function shapeConsumers(
  evidence: Record<string, unknown>,
  measured: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const measuredConsumers = rec(measured["consumers"]);
  const evConsumers = rec(evidence["consumers"]);
  if (measuredConsumers === undefined || evConsumers === undefined) {
    reasons.push("consumers block missing from evidence or measurements");
    return reasons;
  }
  if (!deepEqual(evConsumers, measuredConsumers)) {
    reasons.push("consumers evidence != fresh measurements");
    return reasons;
  }
  reasons.push(...consumerStepFailures(measuredConsumers));
  return reasons;
}

export function shapeMutations(ctx: ShapeContext, evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const mutationsJson = rec(readJsonFile(ctx.mutations));
  if (mutationsJson === undefined) {
    reasons.push("ENOENT: tmp/sharedlib6/mutations.json");
    return reasons;
  }
  if (!deepEqual(evidence["mutations"], mutationsJson["mutations"])) {
    reasons.push("mutations[] evidence != mutation-loop results");
  }
  if (mutationsJson["clean_after"] !== true) {
    reasons.push("mutations left the tree dirty");
  }
  return reasons;
}

function freshSetFromSection2(section2: Record<string, unknown>): Record<string, number> {
  const freshSet: Record<string, number> = {};
  for (const [slice, r] of Object.entries(rec(section2["origin"]) ?? {})) {
    const rr = rec(r);
    if (rr !== undefined) {
      const p = rr["pass"];
      freshSet[slice] = typeof p === "number" ? p : -1;
    }
  }
  return freshSet;
}

function baselineSliceReasons(section2: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  for (const [slice, want] of Object.entries(SECTION2_BASELINE)) {
    const recSlice = rec(rec(section2["origin"])?.[slice]);
    if (recSlice === undefined) {
      reasons.push(`section2 missing slice ${slice}`);
      continue;
    }
    if (recSlice["pass"] !== want) {
      reasons.push(
        `section2 ${slice} pass ${String(recSlice["pass"])} != baseline ${String(want)}`,
      );
    }
    if (recSlice["fail"] !== 0) reasons.push(`section2 ${slice} has failing tests`);
  }
  return reasons;
}

function evidenceSection2Reasons(
  evidence: Record<string, unknown>,
  section2: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const baseline = rec(evidence["baseline"]);
  const after = rec(evidence["after"]);
  if (baseline === undefined || after === undefined) {
    return ["evidence baseline/after blocks missing"];
  }
  if (!deepEqual(baseline["measured_set"], SECTION2_BASELINE)) {
    reasons.push("evidence baseline != Keep baseline");
  }
  if (!deepEqual(after["measured_set"], freshSetFromSection2(section2))) {
    reasons.push("evidence after != fresh section-2 measurements");
  }
  if (evidence["delta"] !== 0) reasons.push("evidence section-2 delta != 0");
  const verdict = rec(rec(evidence["section2"])?.["verdict"]);
  if (verdict?.["consistent"] !== true) {
    reasons.push("section2 verdict not consistent");
  }
  return reasons;
}

export function shapeSection2(ctx: ShapeContext, evidence: Record<string, unknown>): string[] {
  const section2 = rec(readJsonFile(ctx.section2));
  if (section2 === undefined) {
    return ["ENOENT: tmp/sharedlib6/section2.json"];
  }
  return [...baselineSliceReasons(section2), ...evidenceSection2Reasons(evidence, section2)];
}

export function shapeCheckSteps(ctx: ShapeContext, evidence: Record<string, unknown>): string[] {
  const simplify = (list: unknown[]): unknown[] =>
    list.map((g) => {
      const r = rec(g) ?? {};
      return { exit: r["exit"], fail: r["fail"], gate: r["gate"], pass: r["pass"] };
    });
  const evSteps = evidence["check_steps"];
  if (!Array.isArray(evSteps)) return ["evidence check_steps[] missing"];
  if (!deepEqual(simplify(evSteps), simplify(ctx.gates))) {
    return ["evidence check_steps[] != this run's step results"];
  }
  return [];
}

// --- parity -----------------------------------------------------------------

interface ParityStepIndex {
  titles: Map<string, string[]>;
  problems: string[];
}

function parityStepIndex(ctx: ShapeContext, measured: Record<string, unknown>): ParityStepIndex {
  const titles = new Map<string, string[]>();
  const problems: string[] = [];
  const host = rec(rec(measured["consumers"])?.["penumbra-host"]);
  const steps = Array.isArray(host?.["steps"]) ? host["steps"] : [];
  for (const s of steps) {
    const sr = rec(s) ?? {};
    const name = str(sr["name"]);
    if (name.startsWith("parity:")) {
      titles.set(name.slice(7), titlesFromLog(ctx, str(sr["log"]), problems));
    }
  }
  return { titles, problems };
}

function coverageForOrigin(
  origin: string,
  originTitles: string[],
  portedTitles: string[],
  excludedTitles: string[],
): string[] {
  const reasons: string[] = [];
  const covered = new Set([...portedTitles, ...excludedTitles]);
  for (const t of originTitles) {
    if (!covered.has(t)) reasons.push(`origin title not covered: ${t}`);
  }
  for (const t of portedTitles) {
    if (!originTitles.includes(t)) reasons.push(`ported title not in origin: ${t}`);
  }
  for (const t of excludedTitles) {
    if (!originTitles.includes(t)) reasons.push(`excluded title not in origin: ${t}`);
  }
  const dupCheck = [...portedTitles, ...excludedTitles];
  if (new Set(dupCheck).size !== dupCheck.length) {
    reasons.push(`coverage overlap in ${origin}`);
  }
  return reasons;
}

function shapeExcludedCases(parity: Record<string, unknown>): string[] {
  const excluded = parity["excluded_cases"];
  if (!Array.isArray(excluded) || excluded.length !== 5) {
    return ["parity.excluded_cases must list the five uncovered origin titles"];
  }
  const reasons: string[] = [];
  const titles = new Set(
    excluded.map((e) => str(rec(e)?.["origin_title"])).filter((t) => t !== ""),
  );
  for (const want of EXPECTED_EXCLUDED_TITLES) {
    if (!titles.has(want)) reasons.push(`excluded_cases missing "${want}"`);
  }
  return reasons;
}

function shapeReexpressedCoverage(
  originRecs: Record<string, unknown> | undefined,
  idx: ParityStepIndex,
  excluded: unknown,
): { reasons: string[]; ported: number; excludedTotal: number } {
  const reasons: string[] = [];
  let ported = 0;
  let excludedTotal = 0;
  const excludedList = Array.isArray(excluded) ? excluded : [];
  for (const origin of REEXPRESSED_ORIGINS) {
    const parityFile = origin.split("/").pop() ?? "";
    const originTitles = (
      (rec(originRecs?.[origin])?.["titles"] as string[] | undefined) ?? []
    ).map(leaf);
    const excludedTitles = excludedList
      .filter((e) => rec(e)?.["module"] === origin)
      .map((e) => str(rec(e)?.["origin_title"]));
    const portedTitles = (idx.titles.get(parityFile) ?? []).map((t) =>
      leaf(t).replace(/^\[re-expressed\] /, ""),
    );
    ported += portedTitles.length;
    excludedTotal += excludedTitles.length;
    reasons.push(...coverageForOrigin(origin, originTitles, portedTitles, excludedTitles));
  }
  return { reasons, ported, excludedTotal };
}

function shapeVerbatimCoverage(
  originRecs: Record<string, unknown> | undefined,
  idx: ParityStepIndex,
): string[] {
  const reasons: string[] = [];
  for (const [origin, parityFile] of VERBATIM_MAP) {
    const originTitles = (
      (rec(originRecs?.[origin])?.["titles"] as string[] | undefined) ?? []
    ).sort();
    const got = (idx.titles.get(parityFile) ?? []).sort();
    if (!deepEqual(originTitles, got)) {
      reasons.push(`verbatim parity titles for ${parityFile} != origin titles`);
    }
  }
  return reasons;
}

function shapeParityBlocks(
  parity: Record<string, unknown>,
  evidence: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const perFile = parity["per_file"];
  if (!Array.isArray(perFile) || perFile.length !== 7) {
    reasons.push("parity.per_file must hold the seven adapter origins");
  } else {
    const files = new Set(perFile.map((f) => str(rec(f)?.["origin"])).filter((s) => s !== ""));
    for (const slice of Object.keys(SECTION2_BASELINE)) {
      if (slice === "packages/agentchat/test/cli") continue;
      if (!files.has(slice)) reasons.push(`per_file missing origin ${slice}`);
    }
  }
  if (!Array.isArray(parity["shim_logic"]) || parity["shim_logic"].length === 0) {
    reasons.push("parity.shim_logic missing");
  }
  const openFindings = evidence["open_findings"];
  if (
    !Array.isArray(openFindings) ||
    !openFindings.some((f) => str(rec(f)?.["would_confirm"]).includes("delegation-only shim"))
  ) {
    reasons.push('open_findings missing the warm-pool shim inference ("delegation-only shim")');
  }
  return reasons;
}

export function shapeParity(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  measured: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const parity = rec(evidence["parity"]);
  if (parity === undefined) return ["evidence parity block missing"];
  reasons.push(...shapeExcludedCases(parity));
  reasons.push(...shapeParityBlocks(parity, evidence));

  const section2 = rec(readJsonFile(ctx.section2));
  const originRecs = rec(section2?.["origin"]);
  const idx = parityStepIndex(ctx, measured);
  reasons.push(...idx.problems);
  const reexpr = shapeReexpressedCoverage(originRecs, idx, parity["excluded_cases"]);
  reasons.push(...reexpr.reasons);
  if (reexpr.ported + reexpr.excludedTotal !== 43 || reexpr.ported !== 38) {
    reasons.push(
      `re-expressed coverage must be 38 ported + 5 excluded = 43, got ${String(reexpr.ported)}+${String(reexpr.excludedTotal)}`,
    );
  }
  reasons.push(...shapeVerbatimCoverage(originRecs, idx));
  return reasons;
}

// --- verdict consistency ----------------------------------------------------

function allowlistControlFlow(ctx: ShapeContext): string[] {
  const entries = [
    ...loadAllowEntries(join(ctx.packageDir, "qualification", "audit-allowlist.json")),
    ...loadAllowEntries(join(ctx.packageDir, "qualification", "audit-allowlist-dist.json")),
  ];
  return entries
    .filter((e) => e.classification === "pre-approved" && CONTROL_FLOW_TOKEN_RE.test(e.token))
    .map((e) => e.token);
}

function tagLineCounts(
  ctx: ShapeContext,
  tag: string,
): { pass: number; fail: number; problem: string | undefined } {
  const path = join(ctx.logDir, "check-bun-test-gate.log");
  const parsed = parseBunTest(
    existsSync(path) ? readFileSync(path, "utf8") : "",
    "check-bun-test-gate.log",
  );
  return {
    pass: parsed.passTitles.filter((t) => t.includes(`[${tag}]`)).length,
    fail: parsed.failTitles.filter((t) => t.includes(`[${tag}]`)).length,
    problem: parsed.problem,
  };
}

function l3PartReasons(
  evidence: Record<string, unknown>,
  consumers: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const gatesArr = Array.isArray(evidence["gates"]) ? evidence["gates"] : [];
  const l3 = rec(gatesArr[2]) ?? {};
  const parts = rec(l3["parts"]) ?? {};
  const partOf = (name: string): "PASS" | "FAIL" =>
    consumerStepFailures({ [name]: consumers[name] }).length === 0 ? "PASS" : "FAIL";
  if (str(parts["penumbra"]) !== partOf("penumbra-host")) {
    reasons.push("L3 parts.penumbra does not match this run");
  }
  if (str(parts["synthetic"]) !== partOf("infra-host")) {
    reasons.push("L3 parts.synthetic does not match this run");
  }
  return reasons;
}

function l4Green(ctx: ShapeContext): boolean {
  const mutationsJson = rec(readJsonFile(ctx.mutations));
  const muts = Array.isArray(mutationsJson?.["mutations"]) ? mutationsJson["mutations"] : [];
  const allDetected =
    muts.length === 6 &&
    muts.every((m) => {
      const mr = rec(m);
      return mr?.["detected"] === true && mr["post_revert_green"] === true;
    });
  return allDetected && (ctx.gates.find((g) => g.gate === "test-gate")?.exit ?? 1) === 0;
}

const PRE_QUALIFY_STEPS = [
  "typecheck",
  "dist-freshness",
  "typecheck-coverage",
  "lint-guards",
  "eslint",
  "prettier",
  "test-gate",
  "mutations",
  "section2-slice",
  "closure-audit-src",
];

function l6GreenReasons(ctx: ShapeContext): string[] {
  const reasons: string[] = [];
  if (allowlistControlFlow(ctx).length > 0) {
    reasons.push("allowlist entry names a real control-flow path");
  }
  const auditExit = (name: string): number => ctx.gates.find((g) => g.gate === name)?.exit ?? 1;
  if (auditExit("closure-audit-src") !== 0 || auditExit("closure-audit-tarball") !== 0) {
    reasons.push("a closure-audit step (rules b and c) is red in this run");
  }
  const l6 = tagLineCounts(ctx, "L6");
  if (l6.problem !== undefined) reasons.push(l6.problem);
  if (l6.pass < 1 || l6.fail > 0) reasons.push("the [L6] test is not green in this run");
  const b7 = tagLineCounts(ctx, "B7");
  if (b7.pass < 1 || b7.fail > 0) reasons.push("the [B7] tests are not all green in this run");
  const md = existsSync(ctx.evidenceMd) ? readFileSync(ctx.evidenceMd, "utf8") : "";
  if (!/warm pooling is not (?:a )?resume/i.test(md)) {
    reasons.push("the report must state that warm pooling is not resume");
  }
  return reasons;
}

function l1VerdictReasons(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  verdict: (i: number) => string,
): string[] {
  if (verdict(0) !== "PASS") return [];
  const stepExit = (name: string): number => ctx.gates.find((g) => g.gate === name)?.exit ?? 1;
  const reasons: string[] = [];
  const l1Green = stepExit("closure-audit-src") === 0 && stepExit("closure-audit-tarball") === 0;
  if (!l1Green) reasons.push("L1 PASS claimed with a red audit step");
  const cand = rec(evidence["candidate"]);
  if (num(cand?.["files"]) === undefined || num(cand?.["runtime_imports"]) === undefined) {
    reasons.push("L1 PASS needs candidate counts recorded");
  }
  return reasons;
}

function l5VerdictReasons(ctx: ShapeContext, verdict: (i: number) => string): string[] {
  if (verdict(4) !== "PASS") return [];
  const stepExit = (name: string): number => ctx.gates.find((g) => g.gate === name)?.exit ?? 1;
  const manifest = rec(
    readJsonFile(join(ctx.runDir, "pack", "extracted", "package", "package.json")),
  );
  const version = str(manifest?.["version"]);
  const preGreen = PRE_QUALIFY_STEPS.every((g) => stepExit(g) === 0);
  if (!preGreen || version === "0.0.0" || version === "") {
    return ["L5 PASS claimed with a red pre-qualify step or a 0.0.0 version"];
  }
  return [];
}

function l6VerdictReasons(ctx: ShapeContext, verdict: (i: number) => string): string[] {
  const reasons: string[] = [];
  const problems = l6GreenReasons(ctx);
  if (verdict(5) === "PASS" && problems.length > 0) {
    reasons.push(`L6 PASS claimed but: ${problems.join("; ")}`);
  }
  if (allowlistControlFlow(ctx).length > 0 && verdict(5) !== "FAIL") {
    reasons.push("L6 must be FAIL when an allowlist entry names a control-flow path");
  }
  return reasons;
}

/** Consistency rules between the recorded L-verdicts and fresh measurements. */
export function shapeVerdicts(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  measured: Record<string, unknown>,
): string[] {
  const reasons: string[] = [];
  const evGates = evidence["gates"];
  if (!Array.isArray(evGates) || evGates.length !== 6) return reasons;
  const verdict = (i: number): string => str(rec(evGates[i])?.["verdict"]);
  const consumers = rec(measured["consumers"]) ?? {};

  reasons.push(...l1VerdictReasons(ctx, evidence, verdict));
  if (verdict(1) === "PASS" && consumerStepFailures(consumers).length > 0) {
    reasons.push("L2 PASS claimed with a red consumer check");
  }
  reasons.push(...l3PartReasons(evidence, consumers));
  if (verdict(3) === "PASS" && !l4Green(ctx)) {
    reasons.push("L4 PASS claimed with a red test-gate or an undetected mutation");
  }
  reasons.push(...l5VerdictReasons(ctx, verdict));
  reasons.push(...l6VerdictReasons(ctx, verdict));
  return reasons;
}
