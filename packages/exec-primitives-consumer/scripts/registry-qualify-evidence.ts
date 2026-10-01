import {
  CONTENT_SHA256,
  INTEGRITY,
  LOCK_ENTRY,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SHA1,
  SHA256,
  TARBALL_URL,
} from "../src/pin.ts";

const TAG = "qualification/sharedlib6-2026-09-24";
const TAG_COMMIT = "001e12fc79c40d6c3c3a5fdf106d96d420f4c997";
const EOR_HEAD = "fb4e560078baaf9177eb32a44ea0d29186edfa4a";
const NOVA_COMMIT = "e1a65bd77710afb4b3cf67909bd1984bf80837b1";
const LREC = "docs/qualification/exec-primitives-0.1.0-test-consumer";

interface Suite {
  consumer: string;
  file: string;
  pass: number;
}

interface AcpPrimitive {
  id: string;
  primitive: string;
  suites: Suite[];
  infra_host_ids: string[];
}

const ACP_PRIMITIVES_DEF: Array<{
  id: string;
  primitive: string;
  files: string[];
  infra: string[];
}> = [
  {
    id: "stdio-json-rpc-client",
    primitive: "the stdio JSON-RPC client (with framing caps)",
    files: [
      "stdio-acp-client.test.ts",
      "stdio-acp-client-onrequest.test.ts",
      "contract/acp-transport.test.ts",
    ],
    infra: ["[B8]", "[ACP-CLIENTINFO]"],
  },
  {
    id: "process-server",
    primitive: "the process server (process-group supervision)",
    files: [
      "stdio-acp-server.test.ts",
      "cli-spawn.test.ts",
      "cli-spawn-stream.test.ts",
      "contract/process-supervisor.test.ts",
    ],
    infra: ["[T1]", "[T4]", "[T6]", "[T7]"],
  },
  {
    id: "permission-context",
    primitive: "the permission context",
    files: ["stdio-acp-permission.test.ts", "contract/acp-permission.test.ts"],
    infra: ["[PERM-DENY]", "[PERM]"],
  },
  {
    id: "pool-credential-scope",
    primitive: "the pool (host key including a credential-scope digest)",
    files: ["acp-warm-pool.test.ts", "contract/acp-warm-pool.test.ts"],
    infra: ["[SCOPE-2]", "[WARM-POOL]"],
  },
  {
    id: "session-bootstrap",
    primitive: "a host-parameterized session bootstrap with host-supplied clientInfo",
    files: ["contract/acp-session.test.ts"],
    infra: ["[ACP-CLIENTINFO]", "[B6]"],
  },
];

interface ConsumerResult {
  parity: Record<string, number>;
  contract?: Record<string, number>;
  bun_test: { pass: number; fail: number; files: number };
  installed_content_sha256: string;
  install_specifier: string;
  copy_outside_repo: boolean;
  resolved_inside_copy: boolean;
  digest_equal: boolean;
  poison_run: { pass: number; exit: number };
  home_entries_after: string[];
  fixture_toolchain: { typescript: string; "@types/node": string };
  adaptations: Array<{ id: string; change: string }>;
  guard: { exit: number };
  smoke_node?: { exit: number };
}

interface RunJson {
  started_at: string;
  run_dir: string;
  consumers: Record<string, ConsumerResult>;
  artifact: {
    name: string;
    version: string;
    tarball_url: string;
    sha256: string;
    sha1: string;
    integrity: string;
    files: number;
    unpacked_bytes: number;
    content_sha256: string;
    entries: string[];
  };
  pin: { manifest: string; section: string; specifier: string; lock_entry: string };
  release: { http: number; latest: string };
  honesty: { penumbra_runtime_import: boolean };
  toolchain: { bun: string; node: string; bun_node_compat?: string };
  base_sha: string;
  ancestry_floor_sha?: string;
  head_sha: string;
}

function buildAcpPrimitives(run: RunJson): AcpPrimitive[] {
  const ph = run.consumers["penumbra-host"];
  if (!ph) throw new Error("penumbra-host missing from run.json");
  const allCounts: Record<string, number> = { ...ph.parity, ...(ph.contract ?? {}) };
  return ACP_PRIMITIVES_DEF.map((def) => ({
    id: def.id,
    primitive: def.primitive,
    suites: def.files.map((f) => ({
      consumer: "penumbra-host",
      file: f,
      pass: requireCount(allCounts, f),
    })),
    infra_host_ids: def.infra,
  }));
}

function requireCount(counts: Record<string, number>, file: string): number {
  const count = counts[file];
  if (typeof count !== "number") throw new Error(`missing per-file count for ${file}`);
  return count;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function penumbraHostPartCounts(run: RunJson): { parity: number; contract: number } {
  const ph = run.consumers["penumbra-host"];
  if (!ph) throw new Error("penumbra-host missing from run.json");
  const parity = Object.values(ph.parity).reduce((sum, n) => sum + n, 0);
  const contract = Object.values(ph.contract ?? {}).reduce((sum, n) => sum + n, 0);
  if (parity + contract !== ph.bun_test.pass) {
    throw new Error(
      `penumbra-host per-file counts ${parity}+${contract} do not match bun_test.pass ${ph.bun_test.pass}`,
    );
  }
  return { parity, contract };
}

export function renderEvidenceJson(run: RunJson): string {
  const ph = run.consumers["penumbra-host"]!;
  const ih = run.consumers["infra-host"]!;
  const a = run.artifact;
  const lockEntry = LOCK_ENTRY;
  const phParts = penumbraHostPartCounts(run);

  const consumers: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(run.consumers)) {
    const source = `${TAG}:packages/exec-primitives/qualification/consumers/${name}`;
    const consumerObj: Record<string, unknown> = {
      source,
      install_command: "bun add --exact @novaproto/exec-primitives@0.1.0",
      install_specifier: c.install_specifier,
      lock_entry: lockEntry,
      copy_outside_repo: c.copy_outside_repo,
      resolved_inside_copy: c.resolved_inside_copy,
      digest_equal: c.digest_equal,
      installed_content_sha256: c.installed_content_sha256,
      home_entries_after: c.home_entries_after,
      poison_run: c.poison_run,
      guard: c.guard,
      parity: c.parity,
      bun_test: c.bun_test,
      fixture_toolchain: c.fixture_toolchain,
      adaptations: c.adaptations,
    };
    if (c.contract) consumerObj["contract"] = c.contract;
    if (c.smoke_node) consumerObj["smoke_node"] = c.smoke_node;
    consumers[name] = consumerObj;
  }

  const evidence = {
    schema: "exec-primitives-registry-qualification/1",
    follow_up_event_id: 1830,
    decisions: [1948, 2031],
    run_date: run.started_at.slice(0, 10),
    base_sha: run.base_sha,
    ancestry_floor_sha: run.ancestry_floor_sha,
    head_sha: run.head_sha,
    toolchain: run.toolchain,
    evidence_of_record: {
      tag: TAG,
      tag_commit: TAG_COMMIT,
      head_sha: EOR_HEAD,
    },
    artifact: {
      name: a.name,
      version: a.version,
      channel: "registry",
      tarball_url: a.tarball_url,
      sha256: a.sha256,
      sha1: a.sha1,
      integrity: a.integrity,
      files: a.files,
      unpacked_bytes: a.unpacked_bytes,
      content_sha256: a.content_sha256,
      entries: a.entries,
      source_identity: {
        nova_commit: NOVA_COMMIT,
        src_blobs_equal_to_evidence_of_record: true,
      },
    },
    pin: {
      manifest: run.pin.manifest,
      section: run.pin.section,
      specifier: run.pin.specifier,
      lock_entry: run.pin.lock_entry,
    },
    consumers,
    acp_primitives: buildAcpPrimitives(run),
    gates: [
      {
        gate: "L2",
        verdict: "PASS",
        verdict_scope: "registry",
        not_provable_here: [],
        evidence: [
          {
            claim: "artifact hashes match the published tarball",
            status: "confirmed",
            pointer: `sha256=${SHA256}`,
          },
          {
            claim: "installed content digest matches content_sha256",
            status: "confirmed",
            pointer: `content_sha256=${CONTENT_SHA256}`,
          },
          {
            claim: "manifest exact-pins 0.1.0 in devDependencies",
            status: "confirmed",
            pointer: "packages/exec-primitives-consumer/package.json",
          },
          {
            claim: "registry dist-tags.latest is 0.1.0",
            status: "confirmed",
            pointer: `packument_http=${run.release.http}`,
          },
          {
            claim: "llamactl-side install is in the llamactl record",
            status: "inferred",
            pointer: `${LREC}.json`,
          },
        ],
      },
      {
        gate: "L3",
        verdict: "PASS",
        scope: "penumbra+synthetic",
        parts: { penumbra: "PASS", synthetic: "PASS" },
        llamactl_part: {
          repo: "frozename/llamactl",
          record: `${LREC}.json`,
        },
        evidence: [
          {
            claim: "penumbra-host parity suite and contract port pass",
            status: "confirmed",
            pointer: `penumbra-host parity=${phParts.parity} contract=${phParts.contract} total=${ph.bun_test.pass}/${ph.bun_test.fail} across ${plural(ph.bun_test.files, "file")}`,
          },
          {
            claim: "infra-host parity suite passes",
            status: "confirmed",
            pointer: `infra-host ${ih.bun_test.pass}/${ih.bun_test.fail} across ${plural(ih.bun_test.files, "file")}`,
          },
          {
            claim: "llamactl-side install is in the llamactl record",
            status: "inferred",
            pointer: `${LREC}.json`,
          },
        ],
      },
    ],
    carried_forward: ["L1", "L4", "L5", "L6"],
    release: {
      published_event_id: 2024,
      dist_tags_latest: run.release.latest,
    },
    blockers: {
      B1: {
        status: "resolved",
        restated:
          "B1 is resolved by the publication: the published manifest has no private field, no 0.0.0, no workspace dependencies, and ships dist.",
      },
    },
    honesty: {
      channel: "registry",
      adoption_performed: false,
      penumbra_runtime_import: run.honesty.penumbra_runtime_import,
    },
    claims_not_made: [
      "adopted by llamactl",
      "1830 closed",
      "penumbra agentchat migrated",
      "ACP fixture parity in the llamactl consumer",
    ],
    open_findings: [
      {
        item: "dist identity",
        status: "inferred",
        pointer:
          "closure verification V4b (a build of the tag's source compared file by file with the registry tarball's dist/src)",
        note: "pending the coordinator closure verification for the carried-forward L1/L4/L5/L6 bridge",
      },
      {
        item: "llamactl record pointer",
        status: "inferred",
        pointer: "check L item L-37 and closure verification V3 (cross-record pointers)",
        note: `${LREC}.json is named here before the llamactl-side record lands on main`,
      },
      {
        item: "source identity against the nova release",
        status: "inferred",
        pointer:
          "closure verification V4a (a git ls-tree comparison against the nova release commit); check P2-28 re-derives only the tag side against the same constants",
        note: "the runner measures the tag side and carries the release-side blob ids as constants copied from check P2-28",
      },
    ],
  };

  return JSON.stringify(evidence, null, 2);
}

export function renderEvidenceMd(run: RunJson): string {
  const ph = run.consumers["penumbra-host"]!;
  const ih = run.consumers["infra-host"]!;
  const prims = buildAcpPrimitives(run);
  const phParts = penumbraHostPartCounts(run);

  const lines: string[] = [];
  lines.push("## L2 registry install");
  lines.push("");
  lines.push(
    `Verdict: PASS. The published tarball at ${TARBALL_URL} installs from the public npm registry with exact-pinned specifier 0.1.0 in a private test consumer. The artifact hashes (sha256, sha1, sha512), file count, unpacked bytes, content digest, manifest pin, lock entry, and dist-tags.latest are measured by the runner. The llamactl-side install is inferred here from the record pointer ${LREC}.json until that record lands on main.`,
  );
  lines.push("");
  lines.push("## L3 parity");
  lines.push("");
  lines.push(
    `Verdict: PASS (penumbra+synthetic). The penumbra-host consumer passes ${ph.bun_test.pass} tests across ${plural(ph.bun_test.files, "file")} (${phParts.parity} parity plus ${phParts.contract} contract-port tests), and the infra-host consumer passes ${ih.bun_test.pass} tests across ${plural(ih.bun_test.files, "file")}, both against the registry-installed package. The llamactl consumer part is inferred from the llamactl record pointer and is not re-run here.`,
  );
  lines.push("");
  lines.push("## ACP primitives");
  lines.push("");
  lines.push("| id | primitive | suites (penumbra-host) | infra-host ids |");
  lines.push("| --- | --- | --- | --- |");
  for (const p of prims) {
    const suitesStr = p.suites.map((s) => `${s.file} (${s.pass})`).join(", ");
    const infraStr = p.infra_host_ids.join(", ");
    lines.push(`| ${p.id} | ${p.primitive} | ${suitesStr} | ${infraStr} |`);
  }
  lines.push("");
  lines.push("## Evidence of record");
  lines.push("");
  lines.push(
    `The evidence of record is tag ${TAG} (commit ${TAG_COMMIT}, head ${EOR_HEAD}). For source identity, the runner measures the 8 src blob ids at the tag; the nova release side (${NOVA_COMMIT}) is carried here as the copied release constant from check P2-28 pending closure verification V4a. Gates L1, L4, L5, L6 are carried forward from the evidence of record through source identity plus dist identity.`,
  );
  lines.push(
    "Open inferred items: source identity against the nova release is pending closure verification V4a; dist identity is pending closure verification V4b; the llamactl record pointer is pending check L item L-37 and closure verification V3.",
  );
  lines.push("");
  lines.push("## Claims not made");
  lines.push("");
  lines.push("- adopted by llamactl");
  lines.push("- 1830 closed");
  lines.push("- penumbra agentchat migrated");
  lines.push(
    "- ACP fixture parity in the llamactl consumer (scoped to the llamactl consumer only; the ACP primitives themselves are qualified here)",
  );
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push(
    "Run `bun packages/exec-primitives-consumer/scripts/registry-qualify.ts` from the repo root, then `bun packages/exec-primitives-consumer/scripts/registry-qualify.ts --write-evidence` to regenerate this record.",
  );
  lines.push(
    "The 2026-09-24 record reproduces only at the tag, because main no longer carries its harness.",
  );
  lines.push("");

  return lines.join("\n");
}
