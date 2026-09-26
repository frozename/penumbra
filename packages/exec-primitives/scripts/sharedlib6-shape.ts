/**
 * sharedlib6-shape.ts — SHAPE: the committed evidence pair against this run's
 * fresh measurements. validateEvidence() holds every rule and takes the
 * evidence object and the .md text as parameters, so the self-test probes
 * (sharedlib6-shape-probes.ts) run the exact same rules over edited clones.
 * The rules: contract shape and verdict consistency (here and in
 * sharedlib6-shape-measured.ts), field bindings (sharedlib6-shape-bind.ts),
 * and regeneration (sharedlib6-shape-regen.ts): the .json must equal the
 * writer's record rebuilt from this run and the .md must equal its render.
 * runShape() validates the committed pair, then runs the probes: a probe that
 * stays green means a field is no longer bound, and SHAPE fails closed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  shapeAllowlistEntries,
  shapeB8Derivation,
  shapeCandidate,
  shapeGateMeasurements,
  shapeJsonClaims,
  shapeOpenFindings,
  shapePerFile,
  shapeStandInLabels,
} from "./sharedlib6-shape-bind.js";
import { shapeEnvironment } from "./sharedlib6-shape-env.js";
import {
  shapeCheckSteps,
  shapeConsumers,
  shapeMutations,
  shapeParity,
  shapeSection2,
  shapeTarball,
  shapeVerdicts,
} from "./sharedlib6-shape-measured.js";
import { probeReasons } from "./sharedlib6-shape-probes.js";
import { shapeMarkdownRender, shapeRegenerated } from "./sharedlib6-shape-regen.js";
import {
  BASE_SHA,
  canonicalize,
  claimRe,
  EVIDENCE_DATE,
  FORBIDDEN_CLAIMS,
  type GateRec,
  HONESTY,
  NPH_LITERALS,
  readJsonFile,
  rec,
  REQUIRED_BLOCKERS,
  REQUIRED_DEVIATION_RULES,
  type ShapeContext,
  str,
} from "./sharedlib6-shape-util.js";

/** The one place the SHAPE file layout is spelled out. */
export function buildShapeContext(
  repoRoot: string,
  packageDir: string,
  gates: GateRec[],
  git: ShapeContext["git"],
): ShapeContext {
  const runDir = join(repoRoot, "tmp", "sharedlib6");
  const docs = join(repoRoot, "docs", "qualification");
  return {
    repoRoot,
    packageDir,
    runDir,
    logDir: join(runDir, "check-logs"),
    evidenceJson: join(docs, `${EVIDENCE_DATE}-sharedlib6-qualification.json`),
    evidenceMd: join(docs, `${EVIDENCE_DATE}-sharedlib6-qualification.md`),
    measurements: join(runDir, "measurements.json"),
    mutations: join(runDir, "mutations.json"),
    section2: join(runDir, "section2.json"),
    baseSha: BASE_SHA,
    gates,
    git,
  };
}

function shapeHeadSha(ctx: ShapeContext, evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (evidence["base_sha"] !== ctx.baseSha) reasons.push("evidence base_sha != required base");
  const headSha = str(evidence["head_sha"]);
  if (headSha === "") {
    reasons.push("evidence head_sha missing");
    return reasons;
  }
  if (ctx.git(["cat-file", "-e", headSha]).exit !== 0) {
    reasons.push(`evidence head_sha ${headSha} is not a commit`);
    return reasons;
  }
  const listed = ctx
    .git(["rev-list", `${ctx.baseSha}..HEAD`])
    .output.split("\n")
    .map((l) => l.trim());
  if (!listed.includes(headSha)) {
    reasons.push("evidence head_sha is not a commit between base and HEAD");
  }
  return reasons;
}

function shapeHonestyAndClaims(evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (!deepEqualLocal(canonicalize(evidence["honesty"]), canonicalize(HONESTY))) {
    reasons.push(`honesty must equal exactly ${JSON.stringify(HONESTY)} (no extra keys)`);
  }
  if (!deepEqualLocal(evidence["claims_not_made"], FORBIDDEN_CLAIMS)) {
    reasons.push("claims_not_made does not list exactly the required claims");
  }
  const deviations = evidence["deviations"];
  if (
    !Array.isArray(deviations) ||
    deviations.some((d) => {
      const r = rec(d);
      return (
        r === undefined || ["rule", "change", "reason", "pointer"].some((k) => str(r[k]) === "")
      );
    })
  ) {
    reasons.push("deviations[] entries must all carry non-empty rule/change/reason/pointer");
  }
  const rules = new Set(
    (Array.isArray(deviations) ? deviations : []).map((d) => str(rec(d)?.["rule"])),
  );
  for (const rule of REQUIRED_DEVIATION_RULES) {
    if (!rules.has(rule)) reasons.push(`deviations[] missing required rule "${rule}"`);
  }
  return reasons;
}

function deepEqualLocal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function gateEvidenceShape(g: Record<string, unknown>, idx: number): string[] {
  const reasons: string[] = [];
  const label = `L${String(idx + 1)}`;
  if (g["gate"] !== label) reasons.push(`gate ${String(idx + 1)} is not ${label}`);
  if (g["scope"] !== "branch") reasons.push(`${label} scope != branch`);
  if (!["PASS", "FAIL", "DEFERRED"].includes(str(g["verdict"]))) {
    reasons.push(`${label} verdict invalid`);
  }
  const nph = g["not_provable_here"];
  if (!Array.isArray(nph) || nph.length === 0 || nph.some((s) => typeof s !== "string")) {
    reasons.push(`${label} not_provable_here missing or empty`);
  } else {
    for (const lit of NPH_LITERALS[idx + 1] ?? []) {
      if (!nph.some((s) => String(s).includes(lit))) {
        reasons.push(`${label} not_provable_here missing literal "${lit}"`);
      }
    }
  }
  reasons.push(...gateEvidenceEntries(label, g["evidence"]));
  return reasons;
}

/** evidence[]: non-empty, each entry { claim, status, pointer }, and every
 * inferred entry carries would_confirm (section 3). */
function gateEvidenceEntries(label: string, ev: unknown): string[] {
  const reasons: string[] = [];
  const entries = Array.isArray(ev) ? (ev as unknown[]) : [];
  const malformed = entries.some((e) => {
    const er = rec(e);
    return (
      er === undefined ||
      !["confirmed", "inferred"].includes(str(er["status"])) ||
      str(er["pointer"]) === "" ||
      str(er["claim"]) === ""
    );
  });
  if (entries.length === 0 || malformed) reasons.push(`${label} evidence[] malformed`);
  for (const [i, e] of entries.entries()) {
    const er = rec(e);
    if (er?.["status"] === "inferred" && str(er["would_confirm"]) === "") {
      reasons.push(`${label} evidence[${String(i)}] is inferred without would_confirm`);
    }
  }
  return reasons;
}

function shapeL3(g: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (g["verdict"] === "PASS") reasons.push("L3 must never be PASS");
  const parts = rec(g["parts"]);
  if (
    !["PASS", "FAIL"].includes(str(parts?.["penumbra"])) ||
    !["PASS", "FAIL"].includes(str(parts?.["synthetic"])) ||
    parts?.["llamactl"] !== "DEFERRED"
  ) {
    reasons.push("L3 parts malformed");
  }
  if (g["deferred_to"] !== "P2.2/llamactl-adoption") {
    reasons.push("L3 deferred_to wrong");
  }
  if (
    g["verdict"] === "DEFERRED" &&
    (parts?.["penumbra"] !== "PASS" || parts["synthetic"] !== "PASS")
  ) {
    reasons.push("L3 DEFERRED needs both parts PASS");
  }
  return reasons;
}

function shapeGates(evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const evGates = evidence["gates"];
  if (!Array.isArray(evGates) || evGates.length !== 6) {
    reasons.push("evidence gates[] must be exactly six L1..L6 entries");
    return reasons;
  }
  for (const [i, g] of evGates.entries()) {
    reasons.push(...gateEvidenceShape(rec(g) ?? {}, i));
  }
  if (rec(evGates[1])?.["verdict_scope"] !== "stand-in") {
    reasons.push("L2 verdict_scope != stand-in");
  }
  reasons.push(...shapeL3(rec(evGates[2]) ?? {}));
  for (const [i, g] of evGates.entries()) {
    if (i !== 2 && rec(g)?.["verdict"] === "DEFERRED") {
      reasons.push(`DEFERRED appears on gate ${String(i + 1)}`);
    }
  }
  return reasons;
}

function blockerIndex(evidence: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const bl: Record<string, Record<string, unknown>> = {};
  const raw = evidence["blockers"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const er = rec(entry);
      const id = str(er?.["id"] ?? er?.["blocker"]);
      if (id !== "") bl[id] = er ?? {};
    }
  } else {
    for (const [k, v] of Object.entries(rec(raw) ?? {})) {
      const er = rec(v);
      if (er !== undefined) bl[k] = er;
    }
  }
  return bl;
}

function blockerVerdictReasons(
  evidence: Record<string, unknown>,
  bl: Record<string, Record<string, unknown>>,
): string[] {
  const reasons: string[] = [];
  const verdict = (i: number): string => {
    const gatesArr = evidence["gates"];
    return Array.isArray(gatesArr) ? str(rec(gatesArr[i])?.["verdict"]) : "";
  };
  const statusOf = (id: string): string => str(bl[id]?.["status"]);
  if (verdict(1) === "PASS" && statusOf("B1") !== "resolved") {
    reasons.push("L2 PASS needs B1 resolved");
  }
  if (
    verdict(3) === "PASS" &&
    ["B3", "B4", "B6", "B7", "B10"].some((k) => statusOf(k) !== "resolved")
  ) {
    reasons.push("L4 PASS needs B3 B4 B6 B7 B10 resolved");
  }
  if (verdict(5) === "PASS" && statusOf("B7") !== "resolved") {
    reasons.push("L6 PASS needs B7 resolved");
  }
  return reasons;
}

function shapeBlockers(evidence: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const bl = blockerIndex(evidence);
  for (const id of REQUIRED_BLOCKERS) {
    const status = str(bl[id]?.["status"]);
    if (!["resolved", "disproved", "open"].includes(status)) {
      reasons.push(`blocker ${id} status invalid or missing`);
    }
  }
  reasons.push(...blockerVerdictReasons(evidence, bl));
  return reasons;
}

function claimsSectionReasons(md: string): string[] {
  const reasons: string[] = [];
  const sectionRe = /## Claims not made\n([\s\S]*?)(?=\n## |\n?$)/;
  const section = sectionRe.exec(md)?.[1] ?? "";
  const rest = md.replace(sectionRe, "");
  for (const claim of FORBIDDEN_CLAIMS) {
    if (!section.includes(claim)) {
      reasons.push(`claims section missing: ${claim}`);
    }
    if (claimRe(claim).test(rest)) {
      reasons.push(`claim "${claim}" appears outside the Claims-not-made section`);
    }
  }
  return reasons;
}

function shapeForbiddenClaims(ctx: ShapeContext, md: string): string[] {
  const reasons: string[] = [];
  const readme = readFileSync(join(ctx.packageDir, "README.md"), "utf8");
  const manifestText = ["penumbra-host", "infra-host"]
    .map((n) =>
      readFileSync(join(ctx.packageDir, "qualification", "consumers", n, "package.json"), "utf8"),
    )
    .join("\n");
  const gitLog = ctx.git(["log", `${ctx.baseSha}..HEAD`, "--format=%B"]).output;
  for (const claim of FORBIDDEN_CLAIMS) {
    const re = claimRe(claim);
    if (re.test(readme)) reasons.push(`README contains forbidden claim: ${claim}`);
    if (re.test(manifestText)) reasons.push(`consumer manifest contains forbidden claim: ${claim}`);
    if (re.test(gitLog)) reasons.push(`commit messages contain forbidden claim: ${claim}`);
  }
  reasons.push(...claimsSectionReasons(md));
  return reasons;
}

function measuredReasons(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  md: string,
): string[] {
  const measured = rec(readJsonFile(ctx.measurements));
  if (measured === undefined) return ["ENOENT: tmp/sharedlib6/measurements.json"];
  return [
    ...shapeTarball(ctx, evidence, measured),
    ...shapeConsumers(evidence, measured),
    ...shapeParity(ctx, evidence, measured),
    ...shapeVerdicts(ctx, evidence, measured, md),
    ...shapeGateMeasurements(ctx, evidence, measured),
    ...shapePerFile(ctx, evidence, measured),
    ...shapeEnvironment(ctx, evidence, measured),
  ];
}

function evidenceTextReasons(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  md: string,
): string[] {
  return [
    ...shapeCandidate(ctx, evidence),
    ...shapeOpenFindings(ctx, evidence),
    ...shapeJsonClaims(evidence),
    ...shapeStandInLabels(evidence, md),
    ...shapeAllowlistEntries(ctx, evidence),
    ...shapeB8Derivation(ctx, evidence),
    ...shapeRegenerated(ctx, evidence),
    ...shapeMarkdownRender(evidence, md),
  ];
}

/** Every SHAPE rule over one evidence object and its .md text. */
export function validateEvidence(
  ctx: ShapeContext,
  evidence: Record<string, unknown>,
  md: string,
): string[] {
  const reasons: string[] = [];
  if (!existsSync(ctx.evidenceMd)) {
    reasons.push(`ENOENT: ${ctx.evidenceMd}`);
  }
  reasons.push(...shapeHeadSha(ctx, evidence));
  reasons.push(...shapeHonestyAndClaims(evidence));
  reasons.push(...shapeGates(evidence));
  reasons.push(...shapeBlockers(evidence));
  reasons.push(...measuredReasons(ctx, evidence, md));
  reasons.push(...evidenceTextReasons(ctx, evidence, md));
  reasons.push(...shapeMutations(ctx, evidence));
  reasons.push(...shapeSection2(ctx, evidence));
  reasons.push(...shapeCheckSteps(ctx, evidence));
  reasons.push(...shapeForbiddenClaims(ctx, md));
  return reasons;
}

/** SHAPE for the committed pair, then the self-test probes over the same run. */
export function runShape(ctx: ShapeContext): string[] {
  const evidence = rec(readJsonFile(ctx.evidenceJson));
  if (evidence === undefined) return [`ENOENT or unparseable: ${ctx.evidenceJson}`];
  const md = existsSync(ctx.evidenceMd) ? readFileSync(ctx.evidenceMd, "utf8") : "";
  const reasons = validateEvidence(ctx, evidence, md);
  return [
    ...reasons,
    ...probeReasons(evidence, md, reasons, (ev, text) => validateEvidence(ctx, ev, text)),
  ];
}
