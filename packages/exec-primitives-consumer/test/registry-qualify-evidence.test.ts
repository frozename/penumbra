import { describe, expect, test } from "bun:test";

import { renderEvidenceJson, renderEvidenceMd } from "../scripts/registry-qualify-evidence.ts";
import { LOCK_ENTRY } from "../src/pin.ts";

type Run = Parameters<typeof renderEvidenceJson>[0];
type Consumer = Run["consumers"][string];

const PARITY_COUNTS = {
  "stdio-acp-client.test.ts": 11,
  "stdio-acp-client-onrequest.test.ts": 12,
  "stdio-acp-server.test.ts": 13,
  "cli-spawn.test.ts": 14,
  "cli-spawn-stream.test.ts": 15,
  "stdio-acp-permission.test.ts": 16,
  "acp-warm-pool.test.ts": 17,
} as const;

const CONTRACT_COUNTS = {
  "contract/acp-transport.test.ts": 21,
  "contract/process-supervisor.test.ts": 22,
  "contract/acp-permission.test.ts": 23,
  "contract/acp-warm-pool.test.ts": 24,
  "contract/acp-session.test.ts": 25,
} as const;

const OVERLAP_COUNT = 18;

function sumValues(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

const PARITY_TOTAL = sumValues(PARITY_COUNTS);
const CONTRACT_TOTAL = sumValues(CONTRACT_COUNTS);
const PH_PASS = PARITY_TOTAL + CONTRACT_TOTAL;

function makeConsumer(overrides: Partial<Consumer> = {}): Consumer {
  return {
    parity: { "sample.test.ts": 1 },
    bun_test: { pass: 1, fail: 0, files: 1 },
    installed_content_sha256: "installed-content-sha",
    install_specifier: "@novaproto/exec-primitives@0.1.0",
    copy_outside_repo: true,
    resolved_inside_copy: true,
    digest_equal: true,
    poison_run: { pass: 1, exit: 1 },
    home_entries_after: [],
    fixture_toolchain: { typescript: "5.9.2", "@types/node": "24.10.1" },
    adaptations: [],
    guard: { exit: 0 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    started_at: "2026-10-05T23:59:59.000Z",
    run_dir: "/tmp/qualification-run",
    consumers: {
      "penumbra-host": makeConsumer({
        parity: { ...PARITY_COUNTS },
        contract: { ...CONTRACT_COUNTS },
        bun_test: { pass: PH_PASS, fail: 0, files: 12 },
      }),
      "infra-host": makeConsumer({
        parity: { "infra-stdio.test.ts": 7 },
        bun_test: { pass: 7, fail: 0, files: 1 },
      }),
    },
    artifact: {
      name: "@novaproto/exec-primitives",
      version: "0.1.0",
      tarball_url:
        "https://registry.npmjs.org/@novaproto/exec-primitives/-/exec-primitives-0.1.0.tgz",
      sha256: "artifact-sha256",
      sha1: "artifact-sha1",
      integrity: "sha512-artifact",
      files: 8,
      unpacked_bytes: 1024,
      content_sha256: "artifact-content-sha",
      entries: ["dist", "dist/src", "package.json"],
    },
    pin: {
      manifest: "package.json",
      section: "devDependencies",
      specifier: "0.1.0",
      lock_entry: "fixture-lock-entry",
    },
    release: { http: 200, latest: "0.1.0" },
    honesty: { penumbra_runtime_import: false },
    toolchain: { bun: "1.2.20", node: "22.11.0" },
    base_sha: "base-sha-0001",
    head_sha: "head-sha-0002",
    ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, got ${typeof value}`);
  }
  return value;
}

function findRecord(
  value: unknown,
  predicate: (rec: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const item of asArray(value)) {
    const rec = asRecord(item);
    if (predicate(rec)) return rec;
  }
  throw new Error("no entry matched");
}

function parseEvidence(run: Run): Record<string, unknown> {
  return asRecord(JSON.parse(renderEvidenceJson(run)));
}

function consumerOf(run: Run, name: string): Consumer {
  const consumer = run.consumers[name];
  if (!consumer) throw new Error(`fixture consumer ${name} missing`);
  return consumer;
}

function withConsumer(run: Run, name: string, consumer: Consumer): Run {
  return { ...run, consumers: { ...run.consumers, [name]: consumer } };
}

function l3InfraPointer(run: Run): string {
  const l3 = findRecord(parseEvidence(run)["gates"], (g) => g["gate"] === "L3");
  const infra = findRecord(l3["evidence"], (e) => e["claim"] === "infra-host parity suite passes");
  const pointer = infra["pointer"];
  if (typeof pointer !== "string") throw new Error("L3 infra pointer is not a string");
  return pointer;
}

function runWithInfraFiles(files: number): Run {
  const base = makeRun();
  const ih = consumerOf(base, "infra-host");
  return withConsumer(base, "infra-host", { ...ih, bun_test: { pass: 7, fail: 1, files } });
}

describe("registry evidence renderer", () => {
  test("renderEvidenceJson requires a penumbra-host consumer", () => {
    const run = makeRun({ consumers: { "infra-host": makeConsumer() } });
    expect(() => renderEvidenceJson(run)).toThrow("penumbra-host missing from run.json");
  });

  test("renderEvidenceMd requires a penumbra-host consumer", () => {
    const run = makeRun({ consumers: { "infra-host": makeConsumer() } });
    expect(() => renderEvidenceMd(run)).toThrow("penumbra-host missing from run.json");
  });

  test("rejects a bun_test.pass above the parity plus contract sum", () => {
    const base = makeRun();
    const ph = consumerOf(base, "penumbra-host");
    const inflated = { ...ph, bun_test: { ...ph.bun_test, pass: ph.bun_test.pass + 1 } };
    expect(() => renderEvidenceJson(withConsumer(base, "penumbra-host", inflated))).toThrow(
      /per-file counts .* do not match bun_test.pass/,
    );
  });

  test("rejects a parity key renamed away from a required suite file", () => {
    const parity: Record<string, number> = {};
    for (const [file, count] of Object.entries(PARITY_COUNTS)) {
      const key = file === "stdio-acp-server.test.ts" ? "stdio-acp-server-relocated.test.ts" : file;
      parity[key] = count;
    }
    const base = makeRun();
    const renamed = { ...consumerOf(base, "penumbra-host"), parity };
    expect(() => renderEvidenceJson(withConsumer(base, "penumbra-host", renamed))).toThrow(
      "missing per-file count for stdio-acp-server.test.ts",
    );
  });

  test("a key present in both parity and contract resolves to the contract count", () => {
    const base = makeRun();
    const ph = consumerOf(base, "penumbra-host");
    const overlap = {
      ...CONTRACT_COUNTS,
      "acp-warm-pool.test.ts": OVERLAP_COUNT,
    };
    const variant = {
      ...ph,
      contract: overlap,
      bun_test: { ...ph.bun_test, pass: PH_PASS + OVERLAP_COUNT },
    };
    const run = withConsumer(base, "penumbra-host", variant);
    const pool = findRecord(parseEvidence(run)["acp_primitives"], (e) => {
      return e["id"] === "pool-credential-scope";
    });
    const suite = findRecord(pool["suites"], (s) => s["file"] === "acp-warm-pool.test.ts");
    expect(suite["pass"]).toBe(OVERLAP_COUNT);
  });

  test("run_date is the date prefix of started_at", () => {
    expect(parseEvidence(makeRun())["run_date"]).toBe("2026-10-05");
  });

  test("ancestry_floor_sha is absent when omitted and passed through when set", () => {
    expect("ancestry_floor_sha" in parseEvidence(makeRun())).toBe(false);
    const run = { ...makeRun(), ancestry_floor_sha: "floor-sha-0003" };
    expect(parseEvidence(run)["ancestry_floor_sha"]).toBe("floor-sha-0003");
  });

  test("output keeps contract only where the input has it and copies smoke_node when present", () => {
    const base = makeRun();
    const consumers = asRecord(parseEvidence(base)["consumers"]);
    expect("contract" in asRecord(consumers["penumbra-host"])).toBe(true);
    expect("contract" in asRecord(consumers["infra-host"])).toBe(false);
    expect("smoke_node" in asRecord(consumers["infra-host"])).toBe(false);
    const withSmoke = withConsumer(base, "infra-host", {
      ...consumerOf(base, "infra-host"),
      smoke_node: { exit: 0 },
    });
    const updated = asRecord(asRecord(parseEvidence(withSmoke)["consumers"])["infra-host"]);
    expect(updated["smoke_node"]).toEqual({ exit: 0 });
  });

  test("consumer lock_entry always comes from the pin module, top-level pin from the run", () => {
    const base = makeRun();
    const run = { ...base, pin: { ...base.pin, lock_entry: "not-the-lock-entry" } };
    const parsed = parseEvidence(run);
    const consumers = asRecord(parsed["consumers"]);
    expect(asRecord(consumers["penumbra-host"])["lock_entry"]).toBe(LOCK_ENTRY);
    expect(asRecord(consumers["infra-host"])["lock_entry"]).toBe(LOCK_ENTRY);
    expect(asRecord(parsed["pin"])["lock_entry"]).toBe("not-the-lock-entry");
  });

  test("L3 infra pointer uses the singular file wording for one file", () => {
    expect(l3InfraPointer(runWithInfraFiles(1))).toBe("infra-host 7/1 across 1 file");
  });

  test("L3 infra pointer pluralizes for two files", () => {
    expect(l3InfraPointer(runWithInfraFiles(2))).toBe("infra-host 7/1 across 2 files");
  });

  test("markdown table row pins the stdio-json-rpc-client suite counts", () => {
    const lines = renderEvidenceMd(makeRun()).split("\n");
    const expected =
      `| stdio-json-rpc-client | the stdio JSON-RPC client (with framing caps) | ` +
      `stdio-acp-client.test.ts (${String(PARITY_COUNTS["stdio-acp-client.test.ts"])}), ` +
      `stdio-acp-client-onrequest.test.ts (${String(PARITY_COUNTS["stdio-acp-client-onrequest.test.ts"])}), ` +
      `contract/acp-transport.test.ts (${String(CONTRACT_COUNTS["contract/acp-transport.test.ts"])}) | ` +
      `[B8], [ACP-CLIENTINFO] |`;
    expect(lines).toContain(expected);
  });
});
