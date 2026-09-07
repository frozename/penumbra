import { applySchema, loadSqliteVec, readSubscriptionPressure } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexRolloutReader } from "@src/usage-readers/codex-rollout-reader.js";
import { startUsagePoller } from "@src/usage-readers/poller.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function writeRollout(dir: string, name: string, lines: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const tokenCountLine = (
  used_pct_primary: number,
  used_pct_secondary: number,
  resets_p = 1777364441,
  resets_s = 1777545224,
  limitId = "codex",
): Record<string, unknown> => ({
  type: "event_msg",
  timestamp: "2026-04-28T12:00:00Z",
  payload: {
    type: "token_count",
    rate_limits: {
      limit_id: limitId,
      primary: { used_percent: used_pct_primary, window_minutes: 300, resets_at: resets_p },
      secondary: { used_percent: used_pct_secondary, window_minutes: 10080, resets_at: resets_s },
      plan_type: "plus",
      rate_limit_reached_type: null,
    },
  },
});

describe("CodexRolloutReader", () => {
  it("emits one rate-limit-snapshot per window from the latest token_count event", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-aaa.jsonl", [
      tokenCountLine(2.0, 30.0),
      tokenCountLine(3.0, 31.0),
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const result = await reader.read(null);
    expect(result.rate_limit_snapshots).toHaveLength(2);
    const primary = result.rate_limit_snapshots.find((s) => s.window_label === "primary");
    expect(primary?.used_pct).toBe(3.0);
    expect(primary?.window_minutes).toBe(300);
  });

  it("cursor persists byte_offset; second read with same file emits no new snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-bbb.jsonl", [tokenCountLine(5.0, 40.0)]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r1 = await reader.read(null);
    expect(r1.rate_limit_snapshots).toHaveLength(2);
    const r2 = await reader.read(r1.cursor);
    expect(r2.rate_limit_snapshots).toHaveLength(0);
  });

  it("skips rollout files older than the lookback window", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    const oldPath = writeRollout(dayDir, "rollout-2026-04-28T12-00-00-old.jsonl", [
      tokenCountLine(99.0, 99.0),
    ]);
    const newPath = writeRollout(dayDir, "rollout-2026-04-28T12-00-00-new.jsonl", [
      tokenCountLine(5.0, 50.0),
    ]);

    const fakeNow = Date.now();
    const oldEpochSec = (fakeNow - 25 * 60 * 60 * 1000) / 1000;
    const newEpochSec = fakeNow / 1000;
    utimesSync(oldPath, oldEpochSec, oldEpochSec);
    utimesSync(newPath, newEpochSec, newEpochSec);

    const reader = new CodexRolloutReader({
      rootDir: root,
      lookbackHours: 24,
      now: (): number => fakeNow,
    });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    const primary = r.rate_limit_snapshots.find((s) => s.window_label === "primary");
    expect(primary?.used_pct).toBe(5.0);
  });

  it('canonicalizes provider name to "openai"', async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-ccc.jsonl", [tokenCountLine(1.0, 1.0)]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots.every((s) => s.provider === "openai")).toBe(true);
  });

  it("prefers rollout model_provider over codex limit_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-sakana-provider.jsonl", [
      {
        timestamp: "2026-04-28T12:00:00Z",
        type: "session_meta",
        payload: {
          id: "019ef5a8-2653-7590-9ab7-392408693ac2",
          model_provider: "sakana",
          model: "fugu-ultra-20260615",
        },
      },
      tokenCountLine(1.0, 1.0, 1777364441, 1777545224, "codex"),
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.every((s) => s.provider === "sakana")).toBe(true);
  });

  it('preserves non-codex limit_id values such as "sakana"', async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-sakana.jsonl", [
      tokenCountLine(1.0, 2.0, 1777364441, 1777545224, "sakana"),
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots.every((s) => s.provider === "sakana")).toBe(true);
  });

  it("skips corrupt lines, continues parsing", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, "rollout-2026-04-28T12-00-00-ddd.jsonl");
    writeFileSync(
      path,
      ["{not valid json", JSON.stringify(tokenCountLine(7.0, 70.0))].join("\n") + "\n",
    );
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.find((s) => s.window_label === "primary")?.used_pct).toBe(7.0);
  });

  it("returns empty result when root dir is absent", async () => {
    const reader = new CodexRolloutReader({ rootDir: "/tmp/this-does-not-exist-xyz" });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(0);
    expect(r.usage_deltas).toHaveLength(0);
  });

  it("reads only the appended tail on subsequent polls and still finds the latest rate-limit line", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    const path = writeRollout(dayDir, "rollout-2026-04-28T12-00-00-tail.jsonl", [
      tokenCountLine(1.0, 10.0),
    ]);
    const initialSize = statSync(path).size;

    const reader = new CodexRolloutReader({ rootDir: root });
    const r1 = await reader.read(null);
    expect(r1.rate_limit_snapshots).toHaveLength(2);
    expect(r1.rate_limit_snapshots.find((s) => s.window_label === "primary")?.used_pct).toBe(1.0);

    const cursor1 = (r1.cursor as { files: Record<string, { byte_offset: number }> }).files[path];
    expect(cursor1?.byte_offset).toBe(initialSize);

    appendFileSync(path, JSON.stringify(tokenCountLine(9.0, 90.0)) + "\n");
    const appendedSize = statSync(path).size;
    expect(appendedSize).toBeGreaterThan(initialSize);

    const r2 = await reader.read(r1.cursor);
    expect(r2.rate_limit_snapshots).toHaveLength(2);
    expect(r2.rate_limit_snapshots.find((s) => s.window_label === "primary")?.used_pct).toBe(9.0);
    const cursor2 = (r2.cursor as { files: Record<string, { byte_offset: number }> }).files[path];
    expect(cursor2?.byte_offset).toBe(appendedSize);

    appendFileSync(path, "{not valid json on the tail-only path\n");
    const r3 = await reader.read(r2.cursor);
    expect(r3.rate_limit_snapshots).toHaveLength(0);

    appendFileSync(path, JSON.stringify(tokenCountLine(7.0, 70.0)) + "\n");
    const r4 = await reader.read(r3.cursor);
    expect(r4.rate_limit_snapshots).toHaveLength(2);
    expect(r4.rate_limit_snapshots.find((s) => s.window_label === "primary")?.used_pct).toBe(7.0);
  });

  // Snapshot test against a verbatim payload captured from a production codex
  // rollout file (~/.codex/sessions/2026/03/28/...) on 2026-05-08. Locks the
  // reader against upstream Codex schema drift in the rate_limits shape.
  it("parses a verbatim production rate_limits payload (codex-acp 2026-03-28)", async () => {
    const productionLine = {
      timestamp: "2026-03-28T11:25:38.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1774725970 },
          secondary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1775312770 },
          credits: null,
          plan_type: "plus",
        },
      },
    };
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "03", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-03-28T11-25-38-prod-snapshot.jsonl", [productionLine]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    const primary = r.rate_limit_snapshots.find((s) => s.window_label === "primary");
    expect(primary).toBeDefined();
    expect(primary?.provider).toBe("openai");
    expect(primary?.used_pct).toBe(0.0);
    expect(primary?.window_minutes).toBe(300);
    expect(primary?.resets_at).toBe(1774725970);
    expect(primary?.extra).toMatchObject({ plan_type: "plus", limit_id: "codex" });
    const secondary = r.rate_limit_snapshots.find((s) => s.window_label === "secondary");
    expect(secondary?.window_minutes).toBe(10080);
  });

  it("captures prompt-cache tokens from payload.info.last_token_usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-cache.jsonl", [
      {
        timestamp: "2026-04-28T12:00:00Z",
        type: "session_meta",
        payload: {
          id: "019ef5a8-2653-7590-9ab7-392408693ac2",
          model_provider: "openai",
          model: "gpt-5-codex",
        },
      },
      {
        timestamp: "2026-04-28T12:00:05Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 70,
              output_tokens: 30,
              total_tokens: 130,
            },
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 350,
              output_tokens: 150,
              total_tokens: 650,
            },
            model_context_window: 200000,
          },
          rate_limits: null,
        },
      },
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    const d = r.usage_deltas[0]!;
    expect(d.tokens_cache_read).toBe(70);
    expect(d.tokens_input).toBe(100 - 70);
    expect(d.tokens_output).toBe(30);
    expect(d.tokens_cache_write).toBeUndefined();
    expect(d.model).toBe("gpt-5-codex");
    expect(d.provider).toBe("openai");
    expect(d.cost_usd).toBeNull();
  });

  it("prunes cursor entries for files aged past the lookback window across reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    const path = writeRollout(dayDir, "rollout-2026-04-28T12-00-00-prune.jsonl", [
      tokenCountLine(1.0, 10.0),
    ]);

    const t0 = Date.now();
    const readerFresh = new CodexRolloutReader({
      rootDir: root,
      lookbackHours: 24,
      now: (): number => t0,
    });
    const r1 = await readerFresh.read(null);
    const files1 = (r1.cursor as { files: Record<string, unknown> }).files;
    expect(files1[path]).toBeDefined();

    // Age the file past the lookback window before the second read.
    const agedEpochSec = (t0 - 120 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, agedEpochSec, agedEpochSec);

    const readerAged = new CodexRolloutReader({
      rootDir: root,
      lookbackHours: 24,
      now: (): number => t0,
    });
    const r2 = await readerAged.read(r1.cursor);
    const files2 = (r2.cursor as { files: Record<string, unknown> }).files;
    expect(files2[path]).toBeUndefined();
    expect(Object.keys(files2)).toHaveLength(0);
  });

  it("payload.info:null emits no usage_delta but rate-limit parsing still works on the same event", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "04", "28");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-04-28T12-00-00-info-null.jsonl", [
      {
        timestamp: "2026-04-28T12:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 4.0, window_minutes: 300, resets_at: 1777364441 },
            secondary: { used_percent: 40.0, window_minutes: 10080, resets_at: 1777545224 },
            plan_type: "plus",
          },
        },
      },
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(0);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.find((s) => s.window_label === "primary")?.used_pct).toBe(4.0);
    expect(r.rate_limit_snapshots.find((s) => s.window_label === "secondary")?.used_pct).toBe(40.0);
  });

  it("emits a retirement tombstone when a window key is present but null", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "09", "07");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-09-07T15-09-35-retired.jsonl", [
      {
        timestamp: "2026-09-07T15:09:35Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1788798575 },
            secondary: null,
            plan_type: "prolite",
          },
        },
      },
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    const primary = r.rate_limit_snapshots.find((s) => s.window_label === "primary");
    expect(primary?.used_pct).toBe(0.0);
    expect(primary?.retired).toBeUndefined();
    const secondary = r.rate_limit_snapshots.find((s) => s.window_label === "secondary");
    expect(secondary?.retired).toBe(true);
    expect(secondary?.provider).toBe("openai");
  });

  it("emits no tombstone when the window key is absent entirely", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "09", "07");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-09-07T15-09-35-absent.jsonl", [
      {
        timestamp: "2026-09-07T15:09:35Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1788798575 },
            plan_type: "prolite",
          },
        },
      },
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(1);
    expect(r.rate_limit_snapshots[0]?.window_label).toBe("primary");
    expect(r.rate_limit_snapshots[0]?.retired).toBeUndefined();
  });

  it("a present-but-null window retires the group end-to-end through subscription pressure", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);
    db.prepare(
      `
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id,
        event_type, lane, provider, payload_json
      ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
    `,
    ).run(
      "prior-secondary",
      "2026-09-02T18:23:31Z",
      "2026-09-02T18:23:31Z",
      "openai",
      JSON.stringify({
        window_label: "secondary",
        model: null,
        used_pct: 100,
        resets_at: null,
        source_kind: "local-state-codex-rollout",
      }),
    );

    const root = mkdtempSync(join(tmpdir(), "codex-rollout-"));
    const dayDir = join(root, "2026", "09", "07");
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, "rollout-2026-09-07T15-09-35-e2e.jsonl", [
      {
        timestamp: "2026-09-07T15:09:35Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1788798575 },
            secondary: null,
            plan_type: "prolite",
          },
        },
      },
    ]);

    interface EmittedEvent {
      event_id: string;
      ts: string;
      event_type: string;
      provider: string;
      payload_json: Record<string, unknown>;
    }
    const observed: EmittedEvent[] = [];
    const poller = startUsagePoller({
      readers: [new CodexRolloutReader({ rootDir: root })],
      intervalMs: 30_000,
      cursorPath: join(root, "cursors.json"),
      emit: (e) => {
        observed.push(e);
        return Promise.resolve({ event_id: e.event_id });
      },
      log: { info: () => undefined, error: () => undefined },
    });
    await poller.runOnce();
    poller.stop();

    const insert = db.prepare(
      `
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id,
        event_type, lane, provider, payload_json
      ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', ?, 'cli-subscription', ?, ?)
    `,
    );
    for (const e of observed) {
      insert.run(e.event_id, e.ts, e.ts, e.event_type, e.provider, JSON.stringify(e.payload_json));
    }

    const out = readSubscriptionPressure(db, { stale_after_seconds: 1800 });
    expect(out.snapshots.map((s) => s.window_label).sort()).toEqual(["primary"]);
    expect(out.warnings).toEqual([]);
  });
});
