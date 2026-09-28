/**
 * sharedlib6-shape-util.ts — shared constants and helpers for the composite
 * check's SHAPE validation. Kept separate so sharedlib6-check.ts and
 * sharedlib6-shape-measured.ts both stay under the max-lines cap.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBunTest } from "./bun-test-parse.js";

export const BASE_SHA = "c264644bc2b4f1e1429e845208fd6ca7f6426d62";
export const EVIDENCE_DATE = "2026-09-24";

export const FORBIDDEN_CLAIMS = [
  "qualified",
  "ready",
  "released",
  "channel chosen",
  "home chosen",
  "adopted by llamactl",
  "dual-consumer parity",
  "warm pooling is session resume",
];

/** The section-3 honesty object, exactly: extra keys are refused. */
export const HONESTY = {
  channel_stand_in: true,
  channel_chosen: false,
  home_chosen: false,
  adoption_performed: false,
  overall_claim: "none",
};

/** Deviation rules item 6 requires by name, kept apart from the writer's data. */
export const REQUIRED_DEVIATION_RULES = [
  "comment-only bunfig in consumer copies",
  "re-expression two-file split",
  "extra audit fixtures",
];

/** T7: the producer emits 1000000 bytes against a 65536-byte cap. */
export const T7_CAP_BYTES = 65_536;
export const T7_PRODUCED_BYTES = 1_000_000;

/** Keep baseline — origin pass counts pinned by the evidence contract. */
export const SECTION2_BASELINE: Record<string, number> = {
  "packages/agentchat/test/adapters/cli-spawn.test.ts": 24,
  "packages/agentchat/test/adapters/cli-spawn-stream.test.ts": 14,
  "packages/agentchat/test/adapters/stdio-acp-client.test.ts": 11,
  "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts": 6,
  "packages/agentchat/test/adapters/stdio-acp-server.test.ts": 5,
  "packages/agentchat/test/adapters/stdio-acp-permission.test.ts": 29,
  "packages/agentchat/test/adapters/acp-warm-pool.test.ts": 22,
  "packages/agentchat/test/cli": 71,
};

export const REEXPRESSED_ORIGINS = [
  "packages/agentchat/test/adapters/cli-spawn-stream.test.ts",
  "packages/agentchat/test/adapters/stdio-acp-permission.test.ts",
];

/** Origins ported verbatim (import-line diffs only) — parity titles must
 * equal the fresh origin titles exactly. */
export const VERBATIM_MAP: [string, string][] = [
  ["packages/agentchat/test/adapters/cli-spawn.test.ts", "cli-spawn.test.ts"],
  ["packages/agentchat/test/adapters/stdio-acp-client.test.ts", "stdio-acp-client.test.ts"],
  [
    "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts",
    "stdio-acp-client-onrequest.test.ts",
  ],
  ["packages/agentchat/test/adapters/stdio-acp-server.test.ts", "stdio-acp-server.test.ts"],
  ["packages/agentchat/test/adapters/acp-warm-pool.test.ts", "acp-warm-pool.test.ts"],
];

export const EXPECTED_EXCLUDED_TITLES = new Set([
  "GeminiCliAdapter.dispatchStream yields done with correct text",
  "ClaudeCliAdapter.dispatchStream yields done with correct text",
  "CodexCliAdapter.dispatchStream yields done with correct text",
  "dispatch() buffered path still returns correct text on GeminiCliAdapter",
  "preserves the downstream terminal/create executor contract after allow_once",
]);

export const NPH_LITERALS: Record<number, string[]> = {
  2: ["versioned channel", "home", "llamactl-side install"],
  4: ["llamactl injecting its own values"],
  5: ["the versioned release"],
  6: ["real llamactl worker"],
};
/** The run files the evidence writer hashes into artifact_sha256; the check
 * writes its verdict file after SHAPE, so SHAPE cannot require it on disk. */
export const CHECK_VERDICT_FILE = "check.json";
export const ARTIFACT_FILES = [
  CHECK_VERDICT_FILE,
  "measurements.json",
  "mutations.json",
  "section2.json",
];
export const REQUIRED_BLOCKERS = ["B1", "B3", "B4", "B6", "B7", "B8", "B10"];
export const CONTROL_FLOW_TOKEN_RE = /retry|fallback|reconnect|resume|adopt|takeover|attach/i;

export interface GateRec {
  gate: string;
  exit: number;
  pass: number | null;
  fail: number | null;
  log: string;
  gating: boolean;
}

export interface ShapeContext {
  repoRoot: string;
  packageDir: string;
  runDir: string;
  logDir: string;
  evidenceJson: string;
  evidenceMd: string;
  measurements: string;
  mutations: string;
  section2: string;
  baseSha: string;
  gates: GateRec[];
  git: (args: string[]) => { exit: number; output: string };
}

/** A claim phrase with its words joined by any run of spaces or hyphens, so
 * "dual consumer parity" and "home-chosen" match the listed phrases. */
export function claimRe(claim: string): RegExp {
  return new RegExp(`\\b${claim.split(/[\s-]+/).join("[\\s-]+")}\\b`, "i");
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Leaf title — "describe > nested > test" normalizes to "test". */
export function leaf(title: string): string {
  const idx = title.lastIndexOf(" > ");
  return idx === -1 ? title : title.slice(idx + 3);
}

/** Executed full titles from a `bun test` log file under the run dir. A log
 * whose result lines cannot account for its summary is refused: the reason
 * goes to `problems` (bun-test-parse.ts). */
export function titlesFromLog(ctx: ShapeContext, logRel: string, problems: string[]): string[] {
  const path = join(ctx.runDir, logRel);
  if (logRel === "" || !existsSync(path)) return [];
  const parsed = parseBunTest(readFileSync(path, "utf8"), logRel);
  if (parsed.problem !== undefined) problems.push(parsed.problem);
  return parsed.titles;
}

export interface AllowEntry {
  token: string;
  classification: string;
}

export function loadAllowEntries(path: string): AllowEntry[] {
  const raw = readJsonFile(path);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => {
      const r = rec(e);
      return { token: str(r?.["token"]), classification: str(r?.["classification"]) };
    })
    .filter((e) => e.token !== "");
}

/** Open findings SHAPE requires by id: the contract item-13 list, item 8's
 * skipLibCheck record, item 7(g)'s shim inference, the host-input gaps
 * outside the supervisor, and the root-lint attribution. Kept here, apart
 * from the writer's data, so dropping an entry from both still fails. */
export const REQUIRED_OPEN_FINDINGS = [
  "t10-limits",
  "stderr-in-errors",
  "dts-needs-types-node",
  "detect-capacity-provider-specific",
  "stdio-acp-server-sync-throw",
  "cli-spawn-folded",
  "content-length-unanchored",
  "pool-key-nul-joined",
  "log-field-identifiers",
  "stdin-ignore-literal",
  "warm-pool-shim-logic",
  "unpinned-behaviours",
  "abort-listener-comment",
  "outcome-frozen-before-group-gone",
  "review-record-only",
  "consumer-skiplibcheck",
  "b10-logger-stdio-acp-client",
  "b10-logger-stdio-acp-permission",
  "b10-logger-stdio-acp-server",
  "b10-logger-acp-warm-pool",
  "root-lint-qualification-errors",
  "audit-rule-b-syntactic",
  "writer-unconditional-confirmed-claims",
  "artifact-sha256-format-only",
];

/** The `counts <label>: {...}` line of the closure-audit src step log. */
export function auditCounts(logDir: string, label: string): Record<string, number> {
  const path = join(logDir, "check-closure-audit-src.log");
  if (!existsSync(path)) return {};
  const m = new RegExp(`^counts ${label}: (\\{.*\\})$`, "m").exec(readFileSync(path, "utf8"));
  if (m?.[1] === undefined) return {};
  try {
    return JSON.parse(m[1]) as Record<string, number>;
  } catch {
    return {};
  }
}

/** eslint stylish output: error lines under files whose path contains
 * `fragment`, and how many such files carry at least one error. */
export function eslintErrorCounts(
  text: string,
  fragment: string,
): { errors: number; files: number } {
  let file = "";
  let errors = 0;
  const files = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("/")) file = line.trim();
    else if (/^\s+\d+:\d+\s+error\s/.test(line) && file.includes(fragment)) {
      errors += 1;
      files.add(file);
    }
  }
  return { errors, files: files.size };
}
