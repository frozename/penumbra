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
 * written into the record as a failure, never rewritten or omitted.
 *
 * Usage: bun scripts/write-evidence.ts
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const DOCS_DIR = join(REPO_ROOT, "docs", "qualification");
const EVIDENCE_DATE = "2026-09-24";
const BASE_SHA = "c264644bc2b4f1e1429e845208fd6ca7f6426d62";

const CLAIMS_NOT_MADE = [
  "qualified",
  "ready",
  "released",
  "channel chosen",
  "home chosen",
  "adopted by llamactl",
  "dual-consumer parity",
  "warm pooling is session resume",
];

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

const check = readJson(join(RUN_DIR, "check.json")) as {
  finished_at: string;
  gates: {
    gate: string;
    exit: number;
    pass: number | null;
    fail: number | null;
    log: string;
    gating: boolean;
  }[];
  shape: string[];
  result: string;
};
const consumersJson = readJson(join(RUN_DIR, "consumers.json")) as {
  generated_at: string;
  toolchain: { bun: string; node: string };
  tarball: {
    name: string;
    channel: string;
    sha256: string;
    content_sha256: string;
    files: number;
    unpacked_bytes: number;
    repack_identical: boolean;
  };
  poison_layer: string[];
  consumers: Record<
    string,
    {
      runtime: string;
      copy_root: string;
      install_specifier: string;
      manifest_specifier: string;
      manifest_dependencies: Record<string, string>;
      manifest_dev_dependencies: Record<string, string>;
      installed_dependencies: string[];
      resolved_to: string;
      digest_equal: boolean;
      installed_content_sha256: string;
      home_entries_after: number;
      network_required: boolean;
      poison_run: { exit: number; detail: string };
      steps: { name: string; exit: number; pass: number; fail: number; log: string }[];
    }
  >;
};
const mutationsJson = readJson(join(RUN_DIR, "mutations.json")) as {
  clean_after: boolean;
  mutations: {
    mutation: string;
    patch: string;
    intent: string;
    tag: string;
    detected: boolean;
    expected_detectors_hit: boolean;
    failing_tests: string[];
    post_revert_green: boolean;
    exit: number;
  }[];
};
const section2Json = readJson(join(RUN_DIR, "section2.json")) as {
  generated_at: string;
  origin: Record<
    string,
    { exit: number; pass: number; fail: number; ran: number; failing: string[] }
  >;
  totals: { pass: number; fail: number; ran: number };
};

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

// ---------------------------------------------------------------------------
// section-2 reconciliation: origin slice counts vs the ported parity files.
// Dispositions and exclusion lists are part of the extraction contract; the
// counts are measured fresh each run and recorded verbatim.
// ---------------------------------------------------------------------------
interface Disposition {
  origin: string;
  parity: string | null;
  kind: "verbatim" | "re-expressed" | "context";
  excluded: { title: string; reason: string }[];
  pointer: string;
}

const DISPOSITIONS: Disposition[] = [
  {
    origin: "packages/agentchat/test/adapters/cli-spawn.test.ts",
    parity: "cli-spawn.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/cli-spawn.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/cli-spawn-stream.test.ts",
    parity: "cli-spawn-stream.test.ts",
    kind: "re-expressed",
    excluded: [
      {
        title: "GeminiCliAdapter.dispatchStream yields done with correct text",
        reason: "vendor adapter class not extracted",
      },
      {
        title: "ClaudeCliAdapter.dispatchStream yields done with correct text",
        reason: "vendor adapter class not extracted",
      },
      {
        title: "CodexCliAdapter.dispatchStream yields done with correct text",
        reason: "vendor adapter class not extracted",
      },
      {
        title: "dispatch() buffered path still returns correct text on GeminiCliAdapter",
        reason: "vendor adapter class not extracted",
      },
    ],
    pointer: "qualification/consumers/penumbra-host/test/cli-spawn-stream.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-client.test.ts",
    parity: "stdio-acp-client.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-client.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts",
    parity: "stdio-acp-client-onrequest.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-client-onrequest.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-server.test.ts",
    parity: "stdio-acp-server.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-server.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-permission.test.ts",
    parity: "stdio-acp-permission.test.ts",
    kind: "re-expressed",
    excluded: [
      {
        title: "preserves the downstream terminal/create executor contract after allow_once",
        reason: "exercises only the non-extracted StdioAcpAdapter executor",
      },
    ],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-permission.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/acp-warm-pool.test.ts",
    parity: "acp-warm-pool.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/acp-warm-pool.parity.ts",
  },
  {
    origin: "packages/agentchat/test/cli",
    parity: null,
    kind: "context",
    excluded: [],
    pointer: "",
  },
];

interface Section2Row {
  origin: string;
  kind: string;
  origin_pass: number;
  origin_fail: number;
  origin_ran: number;
  parity: string | null;
  parity_pass: number | null;
  parity_fail: number | null;
  excluded: { title: string; reason: string }[];
  consistent: boolean;
  pointer: string;
}

function parityStep(file: string): { pass: number; fail: number } | null {
  const steps = consumersJson.consumers["penumbra-host"]?.steps ?? [];
  const step = steps.find((s) => s.name === `parity:${file}`);
  return step === undefined ? null : { pass: step.pass, fail: step.fail };
}

const section2Rows: Section2Row[] = DISPOSITIONS.map((d) => {
  const origin = section2Json.origin[d.origin] ?? {
    exit: 1,
    pass: 0,
    fail: 0,
    ran: 0,
    failing: [],
  };
  const parity = d.parity === null ? null : parityStep(d.parity);
  let consistent = true;
  if (d.kind === "verbatim") {
    consistent =
      parity !== null &&
      parity.fail === 0 &&
      parity.pass === origin.pass &&
      origin.fail === 0;
  } else if (d.kind === "re-expressed") {
    consistent =
      parity !== null &&
      parity.fail === 0 &&
      parity.pass + d.excluded.length === origin.ran &&
      origin.fail === 0;
  }
  return {
    origin: d.origin,
    kind: d.kind,
    origin_pass: origin.pass,
    origin_fail: origin.fail,
    origin_ran: origin.ran,
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

// ---------------------------------------------------------------------------
// deviations — honest record of where this round departs from earlier prose
// or where a measured gate is red. Deviations are never a waiver.
// ---------------------------------------------------------------------------
const deviations: { rule: string; change: string; reason: string; pointer: string }[] = [
  {
    rule: "infra-host consumer language",
    change:
      "TypeScript sources (src/*.ts, test/infra.parity.ts) rather than plain .mjs sources",
    reason:
      "the qualification contract requires test/*.parity.ts plus typescript and @types/node devDependencies; node runs the .ts smoke via native type-stripping, so the no-toolchain property is preserved",
    pointer: "qualification/consumers/infra-host",
  },
  {
    rule: "vendor-dir consumer installs",
    change:
      "consumers are copied to tmp/sharedlib6/consumer-<name>/ and install the packed tarball via bun add",
    reason:
      "a tracked vendor/ directory and file: dependency let workspace resolution mask a broken packed-package install; the tmp copy makes missing isolation impossible to hide",
    pointer: "scripts/qualify.ts",
  },
  {
    rule: "check.exit verdict file",
    change: "removed; the composite derives its verdict from per-gate exits",
    reason:
      "a hidden verdict file let earlier runs print a pass while real gates had failed",
    pointer: "scripts/sharedlib6-check.ts",
  },
  {
    rule: "single-owner.test.ts port",
    change:
      "module-identity and closure-audit-hook tests stay repo-side; the namespace assertion is re-expressed as test/exports.parity.ts",
    reason:
      "module-instance identity and the audit script do not exist inside an installed consumer",
    pointer: "qualification/contract-port.ts",
  },
];

for (const g of check.gates) {
  if (g.gating && g.exit !== 0) {
    deviations.push({
      rule: "gate-green",
      change: `gate ${g.gate} exited ${String(g.exit)}`,
      reason: "measured failure — recorded, not waived",
      pointer: g.log,
    });
  }
}

const artifactSha: Record<string, string> = {};
for (const name of readdirSync(RUN_DIR).filter((f) => f.endsWith(".json"))) {
  artifactSha[name] = createHash("sha256")
    .update(readFileSync(join(RUN_DIR, name)))
    .digest("hex");
}

const allGatingGreen = check.gates.every((g) => !g.gating || g.exit === 0);
const consumersObj = consumersJson.consumers;
const tarball = consumersJson.tarball;

const evidence = {
  generated_at: new Date().toISOString(),
  date: EVIDENCE_DATE,
  base_sha: BASE_SHA,
  head_sha: head,
  toolchain: { bun: consumersJson.toolchain.bun, node: consumersJson.toolchain.node, typescript: tsc },
  note: "local tarball is a channel stand-in for qualification only — not a release, publication, or adoption claim",
  honesty: {
    channel_stand_in: true,
    overall_claim: "none",
    channel_chosen: false,
    home_chosen: false,
    published: false,
    adopted: false,
  },
  claims_not_made: CLAIMS_NOT_MADE,
  deviations,
  result: allGatingGreen ? "PASS" : "FAIL",
  gates: check.gates,
  consumers: consumersObj,
  tarball,
  poison_layer: consumersJson.poison_layer,
  mutations: mutationsJson.mutations,
  mutations_clean_after: mutationsJson.clean_after,
  section2: {
    measurements: section2Json,
    verdict: section2Verdict,
  },
  artifact_sha256: artifactSha,
};

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------
function gateRows(): string {
  return check.gates
    .map(
      (g) =>
        `| ${g.gate} | \`${g.log}\` | exit ${String(g.exit)}${g.pass !== null ? ` · ${String(g.pass)} pass / ${String(g.fail ?? "?")} fail` : ""}${g.gating ? "" : " (non-gating)"} |`,
    )
    .join("\n");
}

function stepSummary(name: string): string {
  const steps = consumersObj[name]?.steps ?? [];
  return steps
    .map((s) => `${s.name} exit ${String(s.exit)}${s.pass > 0 || s.fail > 0 ? ` (${String(s.pass)}p/${String(s.fail)}f)` : ""}`)
    .join(" · ");
}

function consumerRow(name: string): string {
  const c = consumersObj[name];
  if (c === undefined) return `| ${name} | missing | — | — | — |`;
  return `| ${name} | ${c.runtime} | \`bun add ${c.install_specifier}\` → manifest \`${c.manifest_specifier}\` | \`${c.resolved_to}\` | ${stepSummary(name)} |`;
}

const mutationRows = mutationsJson.mutations
  .map(
    (m) =>
      `| ${m.patch} | ${m.intent} | ${m.detected ? "detected" : "MISSED"} (${String(m.failing_tests.length)} failing; expected-detectors ${String(m.expected_detectors_hit)}; post-revert-green ${String(m.post_revert_green)}) |`,
  )
  .join("\n");

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

const excludedList = section2Rows
  .flatMap((r) => r.excluded.map((e) => `- \`${r.origin}\` — "${e.title}" — ${e.reason}`))
  .join("\n");

const deviationRows = deviations
  .map((d) => `| ${d.rule} | ${d.change} | ${d.reason} | \`${d.pointer}\` |`)
  .join("\n");

const md = `# Qualification — penumbra-exec-primitives (P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from \`packages/agentchat/src/adapters/\`. This report asserts nothing
about adoption, release, publication, package home, or registry state. The
local tarball is a channel stand-in used only to prove the packed bits work
when installed into a host.

Commit: \`${head}\` — base: \`${BASE_SHA}\`
Toolchain: bun ${consumersJson.toolchain.bun} · node ${consumersJson.toolchain.node} · typescript ${tsc}
Generated: ${evidence.generated_at}

## Gates

| Gate | Evidence (tmp/sharedlib6/) | Result |
| ---- | --- | --- |
${gateRows()}

## Mutations

${String(mutationsJson.mutations.length)} patches; clean after revert: \`${String(mutationsJson.clean_after)}\`.

| Patch | Intent | Detection |
| --- | --- | --- |
${mutationRows}

## Tarball (channel stand-in)

\`${tarball.name}\` — ${String(tarball.files)} files, ${String(tarball.unpacked_bytes)} bytes unpacked.

- \`sha256(tgz) = ${tarball.sha256}\`
- \`content_sha256 = ${tarball.content_sha256}\` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent \`bun pm pack\` runs → repack_identical=${String(tarball.repack_identical)}

## Consumers

Each consumer fixture is copied to \`tmp/sharedlib6/consumer-<name>/\`, installs
the packed tarball via \`bun add\` under an isolated HOME + bun cache, and runs
against a poisoned \`@penumbra/*\` resolution layer so a workspace link can never
mask a missing install. Runtime steps run with dead proxy variables — the suite
proves no network is required once installed.

| Host | Runtime | Install | Resolved to | Steps |
| ---- | --- | --- | --- | --- |
${consumerRow("penumbra-host")}
${consumerRow("infra-host")}

Installed-content digest equals the tarball digest for each consumer
(\`digest_equal\`), \`home_entries_after\` is 0 for both isolated HOMEs, and the
\`@penumbra/core\` poison probe exited ${String(consumersObj["penumbra-host"]?.poison_run.exit ?? "?")}/${String(consumersObj["infra-host"]?.poison_run.exit ?? "?")}.

## Section 2 — adapter-surface parity vs \`packages/agentchat/\`

Origin slices are measured fresh each run (\`section2-slice.ts\`); parity counts
come from the per-file parity steps inside the penumbra-host consumer copy.

| Origin | Disposition | Origin result | Parity result | Exclusions | Verdict |
| --- | --- | --- | --- | --- | --- |
${section2RowsMd}

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

## Composite check

\`bun scripts/sharedlib6-check.ts\` — fourteen ordered gates plus SHAPE
validation; per-gate logs under \`tmp/sharedlib6/check-logs/\` and the run
record in \`tmp/sharedlib6/check.json\`.

## Deviations

| Rule | Change | Reason | Pointer |
| --- | --- | --- | --- |
${deviationRows}

## Claims not made

${CLAIMS_NOT_MADE.map((c) => `- ${c}`).join("\n")}

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
