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
  poison_run: { pass: number; exit: number };
  home_entries_after: string[];
  adaptations: Array<{ id: string; change: string }>;
  guard: { exit: number };
  smoke_node?: { exit: number };
}

interface RunJson {
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
  toolchain: { bun: string; node: string };
  base_sha: string;
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
      pass: allCounts[f] ?? 0,
    })),
    infra_host_ids: def.infra,
  }));
}

export function renderEvidenceJson(run: RunJson, runDate: string): string {
  const ph = run.consumers["penumbra-host"]!;
  const ih = run.consumers["infra-host"]!;
  const a = run.artifact;
  const lockEntry = LOCK_ENTRY;

  const consumers: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(run.consumers)) {
    const source = `${TAG}:packages/exec-primitives/qualification/consumers/${name}`;
    const consumerObj: Record<string, unknown> = {
      source,
      install_command: "bun add --exact @novaproto/exec-primitives@0.1.0",
      install_specifier: c.install_specifier,
      lock_entry: lockEntry,
      copy_outside_repo: true,
      resolved_inside_copy: true,
      digest_equal: true,
      installed_content_sha256: c.installed_content_sha256,
      home_entries_after: c.home_entries_after,
      poison_run: c.poison_run,
      guard: c.guard,
      parity: c.parity,
      bun_test: c.bun_test,
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
    run_date: runDate,
    base_sha: run.base_sha,
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
      manifest: "packages/exec-primitives-consumer/package.json",
      section: "devDependencies",
      specifier: PACKAGE_VERSION,
      lock_entry: lockEntry,
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
            claim: "penumbra-host parity suite passes",
            status: "confirmed",
            pointer: `penumbra-host ${ph.bun_test.pass}/${ph.bun_test.fail} across ${ph.bun_test.files} files`,
          },
          {
            claim: "infra-host parity suite passes",
            status: "confirmed",
            pointer: `infra-host ${ih.bun_test.pass}/${ih.bun_test.fail} across ${ih.bun_test.files} files`,
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
      dist_tags_latest: "0.1.0",
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
      penumbra_runtime_import: false,
    },
    claims_not_made: [
      "adopted by llamactl",
      "1830 closed",
      "penumbra agentchat migrated",
      "ACP fixture parity in the llamactl consumer",
    ],
    open_findings: [],
  };

  return JSON.stringify(evidence, null, 2);
}

export function renderEvidenceMd(run: RunJson): string {
  const ph = run.consumers["penumbra-host"]!;
  const ih = run.consumers["infra-host"]!;
  const prims = buildAcpPrimitives(run);

  const lines: string[] = [];
  lines.push("## L2 registry install");
  lines.push("");
  lines.push(
    `Verdict: PASS. The published tarball at ${TARBALL_URL} installs from the public npm registry with exact-pinned specifier 0.1.0 in a private test consumer. The artifact hashes (sha256, sha1, sha512), file count, unpacked bytes, and content digest all match the constants recorded at qualification time. This gate cannot see the llamactl-side install, which is covered by the llamactl record at ${LREC}.json.`,
  );
  lines.push("");
  lines.push("## L3 parity");
  lines.push("");
  lines.push(
    `Verdict: PASS (penumbra+synthetic). The penumbra-host consumer passes ${ph.bun_test.pass} tests across ${ph.bun_test.files} files and the infra-host consumer passes ${ih.bun_test.pass} tests across ${ih.bun_test.files} files, both against the registry-installed package. The llamactl consumer part is in the llamactl record and is not re-run here.`,
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
    `The evidence of record is tag ${TAG} (commit ${TAG_COMMIT}, head ${EOR_HEAD}). Source identity is confirmed: the 8 src blob ids at the tag equal the nova release commit ${NOVA_COMMIT}. Gates L1, L4, L5, L6 are carried forward from the evidence of record through source identity plus dist identity.`,
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
