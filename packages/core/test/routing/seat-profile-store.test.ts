import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestCodingV2BenchRows } from "@src/routing/seat-profile-bench-ingest.js";
import {
  createSeatProfileStore,
  DEFAULT_SEAT_PROFILE_EVIDENCE_PATH,
} from "@src/routing/seat-profile-store.js";
import {
  buildSeatProfile,
  type SeatEvidence,
  type SeatFingerprint,
  seatFingerprintKey,
} from "@src/routing/seat-profile.js";

const ENDED_EPOCH = Math.floor(Date.UTC(2026, 10, 5, 12, 0, 0) / 1000);
const PROFILE_NOW = new Date("2026-11-09T00:00:00.000Z");

const FINGERPRINT: SeatFingerprint = {
  seat_id: "seat-store",
  model_sha: "model-sha-store",
  engine_build: "engine-2026.11",
  template_hash: "template-v1",
  sampling: "greedy",
  harness: "acp-stdio",
  routing_policy: null,
  effort_policy: null,
};
const FINGERPRINT_KEY = seatFingerprintKey(FINGERPRINT);

let evidenceSeq = 0;

function makeEvidence(overrides: Partial<SeatEvidence> = {}): SeatEvidence {
  evidenceSeq += 1;
  return {
    evidence_id: `store-ev-${String(evidenceSeq)}`,
    fingerprint_key: FINGERPRINT_KEY,
    source: "bench",
    root_task_id: `root-${String(evidenceSeq)}`,
    tier: "T1",
    effort: "low",
    budget: 16384,
    context_band: "ctx_8k",
    verdict: "pass",
    outcome: "pass",
    wall_seconds: null,
    recorded_at: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function benchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pass: true,
    outcome: "pass",
    error: null,
    wall_seconds: 12.5,
    task: "cache",
    tier: "T1",
    effort: "low",
    budget: 16384,
    fixture_sha: "fx-sha-1",
    rep: 0,
    label: "coding-v2",
    ended_epoch: ENDED_EPOCH,
    sampling: "greedy",
    routing_policy: null,
    effort_policy: null,
    seed: 7,
    turns: [{ prompt_tokens: 900, completion_tokens: 120 }],
    ...overrides,
  };
}

// bun:test types `.rejects.toThrow(...)` as void — assert rejections by hand.
async function expectRejectsWith(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

describe("seat profile evidence store", () => {
  test("append creates missing parent dirs and read returns records in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const path = join(dir, "nested", "deeper", "evidence.jsonl");
      const store = createSeatProfileStore({ path });
      const records = [makeEvidence(), makeEvidence()];

      const appended = await store.append(records);
      expect(appended.appended).toBe(2);
      expect(appended.duplicates).toBe(0);

      const read = await store.read();
      expect(read.evidence).toEqual(records);
      expect(read.corrupt_lines).toBe(0);

      const missing = createSeatProfileStore({
        path: join(dir, "absent", "evidence.jsonl"),
      });
      const empty = await missing.read();
      expect(empty).toEqual({ evidence: [], corrupt_lines: 0 });
      expect(DEFAULT_SEAT_PROFILE_EVIDENCE_PATH).toBe("~/.penumbra/seat-profiles/evidence.jsonl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-appending duplicates is counted and never duplicates evidence_ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const store = createSeatProfileStore({ path: join(dir, "evidence.jsonl") });
      const a = makeEvidence({ evidence_id: "dup-a" });
      const b = makeEvidence({ evidence_id: "dup-b" });
      await store.append([a, b]);
      const c = makeEvidence({ evidence_id: "dup-c" });

      const second = await store.append([a, c, c]);
      expect(second.duplicates).toBeGreaterThan(0);

      const read = await store.read();
      expect(read.evidence).toHaveLength(3);
      const ids = read.evidence.map((record) => record.evidence_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(["dup-a", "dup-b", "dup-c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt lines are skipped and counted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const path = join(dir, "evidence.jsonl");
      const lines = [
        JSON.stringify(makeEvidence({ evidence_id: "good-1" })),
        "this is not json{",
        JSON.stringify(makeEvidence({ evidence_id: "good-2" })),
      ];
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

      const store = createSeatProfileStore({ path });
      const read = await store.read();
      expect(read.evidence).toHaveLength(2);
      expect(read.evidence.map((record) => record.evidence_id)).toEqual(["good-1", "good-2"]);
      expect(read.corrupt_lines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append validates records and leaves the file untouched on a schema violation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const path = join(dir, "evidence.jsonl");
      const store = createSeatProfileStore({ path });
      await store.append([makeEvidence({ evidence_id: "seed" })]);

      const before = await store.read();
      expect(before.evidence).toHaveLength(1);
      const bytes = readFileSync(path, "utf8");

      const bad = makeEvidence({ evidence_id: "bad", fingerprint_key: "not-a-sha" });
      await expectRejectsWith(store.append([bad]));

      expect(readFileSync(path, "utf8")).toBe(bytes);
      const after = await store.read();
      expect(after.evidence).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("end to end: ingested bench evidence stores and qualifies a seat profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const tasks = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
      const rows = tasks.map((task) => benchRow({ task }));
      const text = rows.map((row) => JSON.stringify(row)).join("\n");
      const { evidence, rejected } = ingestCodingV2BenchRows(text, {
        fingerprint: FINGERPRINT,
      });
      expect(rejected).toEqual([]);
      expect(evidence).toHaveLength(6);

      const store = createSeatProfileStore({ path: join(dir, "evidence.jsonl") });
      await store.append(evidence);
      const { evidence: stored, corrupt_lines } = await store.read();
      expect(corrupt_lines).toBe(0);
      expect(stored).toHaveLength(6);

      const profile = buildSeatProfile(stored, FINGERPRINT, { now: PROFILE_NOW });
      expect(profile.status).toBe("qualified");
      expect(profile.cells).toHaveLength(1);
      const cell = profile.cells[0]!;
      expect(cell.root_tasks).toBe(6);
      expect(cell.pass_rate).toBeCloseTo(1, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent appends are serialized and all records survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const store = createSeatProfileStore({ path: join(dir, "evidence.jsonl") });
      const batches = Array.from({ length: 5 }, (_, i) => [
        makeEvidence({ evidence_id: `batch-${String(i)}-a` }),
        makeEvidence({ evidence_id: `batch-${String(i)}-b` }),
      ]);

      const results = await Promise.all(batches.map((batch) => store.append(batch)));

      const allAppended = results.reduce((sum, r) => sum + r.appended, 0);
      expect(allAppended).toBe(10);

      const read = await store.read();
      expect(read.evidence).toHaveLength(10);
      const ids = read.evidence.map((record) => record.evidence_id);
      expect(new Set(ids).size).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends from independent store instances on the same path do not lose records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const path = join(dir, "evidence.jsonl");
      const storeA = createSeatProfileStore({ path });
      const storeB = createSeatProfileStore({ path });
      const batches = Array.from({ length: 10 }, (_, i) => [
        makeEvidence({ evidence_id: `xinst-${String(i)}-a` }),
        makeEvidence({ evidence_id: `xinst-${String(i)}-b` }),
      ]);

      const results = await Promise.all(
        batches.map((batch, i) => (i % 2 === 0 ? storeA : storeB).append(batch)),
      );

      expect(results.reduce((sum, r) => sum + r.appended, 0)).toBe(20);

      const read = await createSeatProfileStore({ path }).read();
      expect(read.evidence).toHaveLength(20);
      expect(new Set(read.evidence.map((record) => record.evidence_id)).size).toBe(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent appends from separate processes do not lose records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const path = join(dir, "evidence.jsonl");
      const storeModuleHref = new URL("../../src/routing/seat-profile-store.ts", import.meta.url)
        .href;

      const children = Array.from({ length: 6 }, (_, child) => {
        const batches = Array.from({ length: 4 }, (_, batch) =>
          Array.from({ length: 5 }, (_, record) =>
            makeEvidence({
              evidence_id: `proc-${String(child)}-${String(batch)}-${String(record)}`,
            }),
          ),
        );
        const scriptPath = join(dir, `append-${String(child)}.ts`);
        writeFileSync(
          scriptPath,
          [
            `import { createSeatProfileStore } from ${JSON.stringify(storeModuleHref)};`,
            `const store = createSeatProfileStore({ path: ${JSON.stringify(path)} });`,
            `const batches = ${JSON.stringify(batches)};`,
            "for (const batch of batches) {",
            "  await store.append(batch);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
        return Bun.spawn([process.execPath, scriptPath]);
      });

      const parentStore = createSeatProfileStore({ path });
      const parentAppends = Array.from({ length: 3 }, (_, i) =>
        parentStore.append(
          Array.from({ length: 4 }, (_, j) =>
            makeEvidence({ evidence_id: `parent-${String(i)}-${String(j)}` }),
          ),
        ),
      );

      const exits = await Promise.all(
        children.map(async (child) => {
          const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          return { code, stderr };
        }),
      );
      await Promise.all(parentAppends);

      for (const { code, stderr } of exits) {
        expect(stderr).toBe("");
        expect(code).toBe(0);
      }

      const read = await parentStore.read();
      expect(read.corrupt_lines).toBe(0);
      expect(read.evidence).toHaveLength(132);
      expect(new Set(read.evidence.map((record) => record.evidence_id)).size).toBe(132);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent appends with overlapping ids dedup through the queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const store = createSeatProfileStore({ path: join(dir, "evidence.jsonl") });
      const a = makeEvidence({ evidence_id: "shared-a" });
      const b = makeEvidence({ evidence_id: "shared-b" });
      const c = makeEvidence({ evidence_id: "shared-c" });

      const results = await Promise.all([
        store.append([a, b]),
        store.append([b, c]),
        store.append([a, c]),
      ]);

      expect(results.reduce((sum, r) => sum + r.appended, 0)).toBe(3);
      expect(results.reduce((sum, r) => sum + r.duplicates, 0)).toBe(3);

      const read = await store.read();
      expect(read.evidence).toHaveLength(3);
      expect(read.evidence.map((record) => record.evidence_id).sort()).toEqual([
        "shared-a",
        "shared-b",
        "shared-c",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appending to a file without a trailing newline keeps records on separate lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const path = join(dir, "evidence.jsonl");
      const first = makeEvidence({ evidence_id: "noeol-1" });
      writeFileSync(path, JSON.stringify(first), "utf8");

      const store = createSeatProfileStore({ path });
      await store.append([makeEvidence({ evidence_id: "noeol-2" })]);

      const raw = readFileSync(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.split("\n").filter((line) => line.trim() !== "")).toHaveLength(2);

      const read = await store.read();
      expect(read.corrupt_lines).toBe(0);
      expect(read.evidence.map((record) => record.evidence_id)).toEqual(["noeol-1", "noeol-2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("capacity verdicts are stored and excluded from pass rate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-profile-store-"));
    try {
      const passEvidence = makeEvidence({
        evidence_id: "cap-pass",
        verdict: "pass",
        outcome: "pass",
      });
      const capacityEvidence = makeEvidence({
        evidence_id: "cap-capacity",
        verdict: "capacity",
        outcome: "wall-cap",
      });
      const failEvidence = makeEvidence({
        evidence_id: "cap-fail",
        verdict: "fail",
        outcome: "model-fail",
      });

      const store = createSeatProfileStore({ path: join(dir, "evidence.jsonl") });
      await store.append([passEvidence, capacityEvidence, failEvidence]);

      const { evidence: stored } = await store.read();
      expect(stored).toHaveLength(3);
      expect(stored.find((e) => e.evidence_id === "cap-pass")?.verdict).toBe("pass");
      expect(stored.find((e) => e.evidence_id === "cap-capacity")?.verdict).toBe("capacity");
      expect(stored.find((e) => e.evidence_id === "cap-fail")?.verdict).toBe("fail");

      const profile = buildSeatProfile(stored, FINGERPRINT, {
        now: PROFILE_NOW,
        minRootTasks: 2,
      });
      expect(profile.status).toBe("qualified");
      const cell = profile.cells[0]!;
      expect(cell.root_tasks).toBe(2);
      expect(cell.capacity_root_tasks).toBe(1);
      expect(cell.attempts).toBe(3);
      expect(cell.pass_rate).toBeCloseTo(0.5, 10);
      expect(cell.capacity_count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
