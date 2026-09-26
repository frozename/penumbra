/**
 * sharedlib6-shape-regen.ts — SHAPE's regeneration binding. The writer's own
 * builder (write-evidence-build.ts) runs over the check's fresh run; the
 * committed .json must equal the result field for field, so every count,
 * claim string, blocker, deviation, allowlist entry and adaptation is bound
 * to this run. Exempt from equality, each bound elsewhere or an environment
 * record:
 *   - head_sha (rev-list membership, sharedlib6-shape.ts), generated_at;
 *   - toolchain and poison_layer (the environment: a fresh worktree install
 *     links fewer @penumbra packages than a long-lived one);
 *   - artifact_sha256 (hashes run files that carry timestamps);
 *   - mutations[].errors (0..failing, sharedlib6-shape-measured.ts);
 *   - gates[L4].measurements.t7_overshoot_bytes (domain, t7Reasons).
 * The .md must equal renderEvidenceMarkdown() of the committed .json byte for
 * byte, so it inherits every binding of the .json.
 */
import { rec, type ShapeContext } from "./sharedlib6-shape-util.js";
import { buildEvidence } from "./write-evidence-build.js";
import { renderEvidenceMarkdown } from "./write-evidence-md.js";

type Ev = Record<string, unknown>;

export const REGEN_EXEMPT_KEYS = [
  "head_sha",
  "generated_at",
  "toolchain",
  "poison_layer",
  "artifact_sha256",
];
const DIFF_LIMIT = 25;

interface Regen {
  evidence?: Ev;
  error?: string;
}

const cache = new Map<string, Regen>();

/** One build per run and step set; the self-test probes reuse it. */
function regenerate(ctx: ShapeContext): Regen {
  const key = JSON.stringify([ctx.repoRoot, ctx.runDir, ctx.gates]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out: Regen;
  try {
    out = {
      evidence: buildEvidence({
        repoRoot: ctx.repoRoot,
        packageDir: ctx.packageDir,
        runDir: ctx.runDir,
        checkSteps: ctx.gates,
        head: "",
        typescript: "",
        generatedAt: "",
      }),
    };
  } catch (err) {
    out = { error: err instanceof Error ? err.message : String(err) };
  }
  cache.set(key, out);
  return out;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

/** The regenerated record with each exempt field taken from `committed`. */
function withExemptions(fresh: Ev, committed: Ev): Ev {
  const out: Ev = Object.fromEntries(
    Object.entries(structuredClone(fresh)).filter(([k]) => !REGEN_EXEMPT_KEYS.includes(k)),
  );
  for (const k of REGEN_EXEMPT_KEYS) {
    if (k in committed) out[k] = committed[k];
  }
  const committedMutations = list(committed["mutations"]);
  for (const [i, m] of list(out["mutations"]).entries()) {
    const c = rec(committedMutations[i]);
    const r = rec(m);
    if (r !== undefined && c !== undefined && "errors" in c) r["errors"] = c["errors"];
  }
  const freshL4 = rec(rec(list(out["gates"])[3])?.["measurements"]);
  const committedL4 = rec(rec(list(committed["gates"])[3])?.["measurements"]);
  if (freshL4 !== undefined && committedL4 !== undefined && "t7_overshoot_bytes" in committedL4) {
    freshL4["t7_overshoot_bytes"] = committedL4["t7_overshoot_bytes"];
  }
  return out;
}

function short(v: unknown): string {
  const text = v === undefined ? "undefined" : JSON.stringify(v);
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function diffArray(got: unknown[], want: unknown[], path: string, out: string[]): void {
  if (got.length !== want.length) {
    out.push(`${path} has ${String(got.length)} entries, regenerated ${String(want.length)}`);
  }
  for (let i = 0; i < Math.min(got.length, want.length); i += 1) {
    diff(got[i], want[i], `${path}[${String(i)}]`, out);
  }
}

function diffObject(got: Ev, want: Ev, path: string, out: string[]): void {
  for (const k of [...new Set([...Object.keys(got), ...Object.keys(want)])].sort()) {
    if (!(k in want)) out.push(`${path}.${k} is not in the regenerated record`);
    else if (!(k in got)) out.push(`${path}.${k} missing (regenerated ${short(want[k])})`);
    else diff(got[k], want[k], `${path}.${k}`, out);
  }
}

/** Every differing path between `got` and `want`, up to DIFF_LIMIT. */
function diff(got: unknown, want: unknown, path: string, out: string[]): void {
  if (out.length >= DIFF_LIMIT) return;
  if (Array.isArray(got) && Array.isArray(want)) {
    diffArray(got as unknown[], want as unknown[], path, out);
    return;
  }
  const g = rec(got);
  const w = rec(want);
  if (g !== undefined && w !== undefined) {
    diffObject(g, w, path, out);
  } else if (JSON.stringify(got) !== JSON.stringify(want)) {
    out.push(`${path} ${short(got)} != regenerated ${short(want)}`);
  }
}

/** The committed .json against the record rebuilt from this run. */
export function shapeRegenerated(ctx: ShapeContext, evidence: Ev): string[] {
  const regen = regenerate(ctx);
  if (regen.evidence === undefined) {
    return [`regenerate: the writer's builder fails on this run: ${regen.error ?? "unknown"}`];
  }
  const out: string[] = [];
  diff(evidence, withExemptions(regen.evidence, evidence), "evidence", out);
  return out.length < DIFF_LIMIT ? out : [...out, "evidence: further differences not listed"];
}

/** The committed .md against the render of the committed .json. */
export function shapeMarkdownRender(evidence: Ev, md: string): string[] {
  let want: string;
  try {
    want = renderEvidenceMarkdown(evidence);
  } catch (err) {
    return [`evidence .md: the committed .json does not render (${String(err)})`];
  }
  if (want === md) return [];
  const got = md.split("\n");
  const exp = want.split("\n");
  let i = 0;
  while (i < got.length && i < exp.length && got[i] === exp[i]) i += 1;
  return [
    `evidence .md differs from the render of the committed .json at line ${String(i + 1)}: ${short(got[i] ?? "<eof>")} != rendered ${short(exp[i] ?? "<eof>")}`,
  ];
}
