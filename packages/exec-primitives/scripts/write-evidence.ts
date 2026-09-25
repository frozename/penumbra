/**
 * write-evidence.ts — assemble the committed qualification evidence pair from
 * the run artifacts under tmp/sharedlib6-run/ (produced by
 * scripts/sharedlib6-check.ts). Writes:
 *
 *   docs/qualification/<date>-sharedlib6-qualification.json
 *   docs/qualification/<date>-sharedlib6-qualification.md
 *   docs/qualification/<date>-sharedlib6-section-2-delta.md
 *
 * The writer refuses to emit when check.exit is non-zero or an artifact is
 * missing — committed evidence must always trace to a green run.
 *
 * Usage: bun scripts/write-evidence.ts [YYYY-MM-DD]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6-run");
const DOCS_DIR = join(REPO_ROOT, "docs", "qualification");

function fail(msg: string): never {
  process.stderr.write(`write-evidence: FAIL — ${msg}\n`);
  process.exit(1);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) fail(`missing artifact ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

if (readFileSync(join(RUN_DIR, "check.exit"), "utf8").trim() !== "0") {
  fail("check.exit is not 0 — evidence may only be emitted for a green run");
}

const check = readJson(join(RUN_DIR, "check.json")) as {
  gates: { gate: string; exit: number; pass: string | null; fail: string | null }[];
  result: string;
};
const consumers = readJson(join(RUN_DIR, "consumers.json")) as Record<string, unknown>;
const mutations = readJson(join(RUN_DIR, "mutations.json")) as {
  clean_after: boolean;
  mutations: {
    patch: string;
    intent: string;
    detected: boolean;
    expected_detectors_hit: boolean;
    failing_tests: string[];
  }[];
};

for (const gate of check.gates) {
  if (gate.exit !== 0) fail(`gate ${gate.gate} exited ${String(gate.exit)} — refusing evidence`);
}
if (!mutations.clean_after) fail("mutations.json reports a dirty tree after revert");
if (!mutations.mutations.every((m) => m.detected && m.expected_detectors_hit)) {
  fail("not every mutation was detected by its expected tests");
}

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`bad date ${date}`);

const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  stdout: "pipe",
})
  .stdout.toString()
  .trim();
const bun = Bun.spawnSync(["bun", "--version"], { cwd: REPO_ROOT, stdout: "pipe" })
  .stdout.toString()
  .trim();
const node = Bun.spawnSync(["node", "--version"], { cwd: REPO_ROOT, stdout: "pipe" })
  .stdout.toString()
  .trim();
const tsc = Bun.spawnSync(["bunx", "tsc", "--version"], {
  cwd: REPO_ROOT,
  stdout: "pipe",
})
  .stdout.toString()
  .trim()
  .replace(/^Version\s+/, "");

const artifactSha: Record<string, string> = {};
for (const name of readdirSync(RUN_DIR).filter((f) => f.endsWith(".json") || f === "check.exit")) {
  const { createHash } = await import("node:crypto");
  artifactSha[name] = createHash("sha256")
    .update(readFileSync(join(RUN_DIR, name)))
    .digest("hex");
}

const evidence = {
  generated_at: new Date().toISOString(),
  commit: head,
  base: "c264644bc2b4f1e1429e845208fd6ca7f6426d62",
  toolchain: { bun, node, typescript: tsc },
  note: "local tarball is a channel stand-in for qualification only — not a release, publication, or adoption claim",
  gates: check.gates,
  result: check.result,
  mutations: {
    count: mutations.mutations.length,
    all_detected: mutations.mutations.every((m) => m.detected),
    all_expected_detectors_hit: mutations.mutations.every((m) => m.expected_detectors_hit),
    clean_after: mutations.clean_after,
  },
  consumers: (consumers as { consumers?: unknown }).consumers ?? consumers,
  tarball: (consumers as { tarball?: unknown }).tarball ?? null,
  artifact_sha256: artifactSha,
};

const consumersObj = (
  consumers as {
    consumers: Record<
      string,
      {
        contract?: { pass: number | null; fail: number | null };
        parity?: { pass: number | null; fail: number | null; files?: string[] };
        smoke_exit?: number;
        smoke_node_exit?: number;
        smoke_bun_exit?: number;
        resolved_to?: string;
        runtime?: string;
        runtime_node?: string;
      }
    >;
    tarball: {
      name: string;
      sha256: string;
      content_sha256: string;
      files: number;
      unpacked_bytes: number;
      repack_identical: boolean;
    };
  }
).consumers;
const tarball = (
  consumers as {
    tarball: {
      name: string;
      sha256: string;
      content_sha256: string;
      files: number;
      unpacked_bytes: number;
      repack_identical: boolean;
    };
  }
).tarball;

const gateRows = check.gates
  .map(
    (g) =>
      `| ${g.gate} | check-${g.gate}.log | exit ${String(g.exit)}${g.pass !== null ? ` · ${g.pass} pass / ${g.fail ?? "?"} fail` : ""} |`,
  )
  .join("\n");

const mutationRows = mutations.mutations
  .map(
    (m) =>
      `| ${m.patch} | ${m.intent} | ${m.detected ? "detected" : "MISSED"} (${String(m.failing_tests.length)} failing) |`,
  )
  .join("\n");

const md = `# Qualification — penumbra-exec-primitives (P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from \`packages/agentchat/src/adapters/\`. This report asserts nothing
about adoption, release, publication, package home, or registry state. The
local tarball is a channel stand-in used only to prove the packed bits work
when installed into a host.

Commit: \`${head}\` — base: \`c264644bc2b4f1e1429e845208fd6ca7f6426d62\`
Toolchain: bun ${bun} · node ${node} · typescript ${tsc}
Generated: ${evidence.generated_at}

## Gates

| Gate | Evidence (tmp/sharedlib6-run/) | Result |
| ---- | --- | --- |
${gateRows}

## Mutations

${mutations.mutations.length} patches, all detected, tree clean after revert (\`clean_after: ${String(mutations.clean_after)}\`).

| Patch | Intent | Detection |
| --- | --- | --- |
${mutationRows}

## Tarball (channel stand-in)

\`${tarball.name}\` — ${String(tarball.files)} files, ${String(tarball.unpacked_bytes)} bytes unpacked.

- \`sha256(tgz) = ${tarball.sha256}\`
- \`content_sha256 = ${tarball.content_sha256}\` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent \`bun pm pack\` runs → repack_identical=${String(tarball.repack_identical)}

## Consumers

| Host | Runtime | Install | Resolved to | Result |
| ---- | --- | --- | --- | --- |
| penumbra-host | ${consumersObj["penumbra-host"]?.runtime ?? "?"} | file: vendored tarball | \`${consumersObj["penumbra-host"]?.resolved_to ?? "?"}\` | contract ${String(consumersObj["penumbra-host"]?.contract?.pass ?? "?")}p/${String(consumersObj["penumbra-host"]?.contract?.fail ?? "?")}f · parity ${String(consumersObj["penumbra-host"]?.parity?.pass ?? "?")}p/${String(consumersObj["penumbra-host"]?.parity?.fail ?? "?")}f · smoke exit ${String(consumersObj["penumbra-host"]?.smoke_exit)} |
| infra-host | bun + node ${consumersObj["infra-host"]?.runtime_node ?? "?"} | file: vendored tarball | \`${consumersObj["infra-host"]?.resolved_to ?? "?"}\` | parity ${String(consumersObj["infra-host"]?.parity?.pass ?? "?")}p/${String(consumersObj["infra-host"]?.parity?.fail ?? "?")}f · smoke node exit ${String(consumersObj["infra-host"]?.smoke_node_exit)} / bun exit ${String(consumersObj["infra-host"]?.smoke_bun_exit)} |

The poison check verified each consumer resolves \`penumbra-exec-primitives\`
inside its own \`node_modules\` — the workspace-root link can never mask a
missing vendor install. infra-host runs plain \`.mjs\` sources (no Bun/TS
runtime coupling) and completes real spawned-subprocess ACP sessions
(initialize → authenticate retry → session/new → session/prompt) against
\`fixtures/fake-acp.mjs\`.

## Parity vs \`packages/agentchat/test/adapters/\`

- Ported verbatim over a local shim surface (src/shim/*): cli-spawn (24),
  stdio-acp-client (11), stdio-acp-client-onrequest (6), stdio-acp-server (5),
  acp-warm-pool (22) — 68 tests.
- Re-expressed against the extracted primitives (permission context + stream
  semantics the old adapter glued to Penumbra dispatch types): 38 tests in
  permission-and-stream.parity.ts.
- Contract suite ported to run against the packed bits via
  qualification/contract-port.ts (test/contract/, generated per run);
  single-owner stays repo-side (module-instance identity cannot survive a
  package boundary).
- See \`${date}-sharedlib6-section-2-delta.md\` for the per-file disposition.

## Composite check

\`bun scripts/sharedlib6-check.ts\` → \`PASS (exit=0)\`; per-gate logs under
\`tmp/sharedlib6-run/check-*.log\`, verdict in \`check.exit\` + \`check.json\`.

## Scope of claim

Qualification only. No release, no publication, no production-readiness and no
llamactl or agentchat adoption is asserted. Parity is bounded by the suites
actually executed and recorded above.
`;

const delta = `# Section 2 — surface delta: \`packages/agentchat/src/adapters/*\` → \`penumbra-exec-primitives\`

Generated ${evidence.generated_at} at commit ${head}. Baseline for the
extraction boundary: what changed, and which original-behavior surfaces are
intentionally not preserved.

## Boundary imports removed

| Adapter source | Removed import | Replaced by |
| --- | --- | --- |
| \`cli-spawn.ts\` | \`@penumbra/core\` (DispatchEventInput), \`@src/sdk/adapter.js\` (DispatchEvent), \`@src/worker/thought-capture.js\` | File deleted; generic supervision extracted to \`process-supervisor.ts\` |
| \`stdio-acp-permission.ts\` | \`@src/sdk/adapter.js\` (DispatchInput) | \`PermissionHost\` — host passes \`signal\`, \`dispatchId\`, \`decide\`, \`logger\` |
| \`stdio-acp-server.ts\` | none (was already local) | \`console.error\` → \`logger\`; stderr tee → \`onStderrChunk\` callback |
| \`stdio-acp-client.ts\` | none | \`console.*\` → \`ExecLogger\`; close-guards added |
| \`acp-warm-pool.ts\` | \`@src/adapters/stdio-acp-client.js\` (type-level) | \`AcpPoolClient\` structural type (no runtime import) |

## Renamed / reshaped surfaces

| Before (agentchat) | After (exec-primitives) | Note |
| --- | --- | --- |
| \`spawnCliAdapter(opts)\` | \`superviseProcess(opts)\` | Dispatch events, thought capture, SDK types removed; \`command\` (was \`binary\`), \`env\`+\`signal\`+\`cancelGraceMs\`+\`watchdogMs\` are required host inputs |
| \`spawnCliAdapterStream\` | not extracted | Streaming dispatch is Penumbra orchestration, not an execution primitive |
| \`startStdioAcpServer({binary,...})\` | \`startStdioAcpServer({command, env, signal, cancelGraceMs, stderrTailBytes, ...})\` | env never defaults; stderr is never teed to process.stderr |
| \`createAcpWarmPool\` key/refcount | \`acquire(spec)\`/\`deposit(spec, entry)\`, \`poolKeyFor(spec)\` requiring \`credentialScope\` | ownership-transfer semantics; cross-credential reuse impossible by construction |
| \`StdioAcpAdapter.dispatch\` permission flow | \`handleStdioAcpPermissionRequest(host, context, wireRequest)\` | adapter class not extracted; wire handler + \`StdioAcpPermissionContext\` are |

## Parity classification vs \`packages/agentchat/test/adapters/\` (102 origin tests)

| Origin file | Tests | Disposition |
| --- | --- | --- |
| \`cli-spawn.test.ts\` | 24 | Ported verbatim over \`src/shim/cli-spawn.ts\` |
| \`stdio-acp-client.test.ts\` | 11 | Ported verbatim over \`src/shim/stdio-acp-client.ts\` |
| \`stdio-acp-client-onrequest.test.ts\` | 6 | Ported verbatim over the same shim |
| \`stdio-acp-server.test.ts\` | 5 | Ported verbatim over \`src/shim/stdio-acp-server.ts\` |
| \`acp-warm-pool.test.ts\` | 22 | Ported verbatim over \`src/shim/acp-warm-pool.ts\` (holder/refcount layer rebuilt over the packed pool) |
| \`stdio-acp-permission.test.ts\` | 20 | Re-expressed as 28 cases in \`test/permission-and-stream.parity.ts\` against \`StdioAcpPermissionContext\` + \`handleStdioAcpPermissionRequest\` (terminal-status rows parameterize the same assertions) |
| \`cli-spawn-stream.test.ts\` | 14 | Stream half re-expressed (10); vendor-adapter wiring (4) excluded — classes not extracted |

Ported 68 verbatim + 38 re-expressed = 106 parity tests executed against the
packed tarball. Excluded origin cases exercise the non-extracted
\`StdioAcpAdapter\` executor or vendor adapter classes; each exclusion is a
Penumbra-side orchestration surface the extraction deliberately left behind.

## Behavior changes that are deliberate

- No \`@penumbra/*\`, \`@src/*\`, \`process.env\`, \`console.*\`, or ambient
  filesystem/config access in \`src/\` — enforced by \`scripts/closure-audit.ts\`
  (src, consumers, packed tarball, plus a self-test fixture suite).
- Environment is verbatim: the child sees exactly \`HostEnv\` (mutation b guards
  the leak).
- Logger is opt-in: without an \`ExecLogger\` the library writes nothing.
- \`StdioAcpClient\` rejects requests on a closed transport with
  \`AcpTransportClosedError\`; JSON-RPC error replies surface as
  \`AcpResponseError\` (with \`.code\`), which \`initializeAcpSession\` uses for
  the \`-32000\` auth retry.
- Warm-pool keys are credential-scoped; \`poolKeyFor\` fails closed
  (\`HostInputError\`) on a missing scope.
`;

mkdirSync(DOCS_DIR, { recursive: true });
const jsonPath = join(DOCS_DIR, `${date}-sharedlib6-qualification.json`);
const mdPath = join(DOCS_DIR, `${date}-sharedlib6-qualification.md`);
const deltaPath = join(DOCS_DIR, `${date}-sharedlib6-section-2-delta.md`);
writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(mdPath, md);
writeFileSync(deltaPath, delta);
process.stdout.write(`write-evidence: wrote ${jsonPath}\n${mdPath}\n${deltaPath}\n`);
