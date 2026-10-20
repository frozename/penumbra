import {
  applySchema,
  loadSqliteVec,
  readSubscriptionPressure,
  T0EventSchema,
  T0Writer,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { TOOL_REGISTRY } from "@src/tools/registry.js";
import {
  subscriptionPressureStatusHandler,
  SubscriptionPressureStatusInputSchema,
} from "@src/tools/subscription-pressure-status.js";

import { fakeDaemon } from "../helpers.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {
  // SQLite is already loaded in this process.
}

type SubscriptionPressureStatusFn = DaemonClient["subscriptionPressureStatus"];
type SubscriptionPressureStatusReq = Parameters<SubscriptionPressureStatusFn>[0];

describe("subscription_pressure_status input schema", () => {
  it("accepts no arguments", () => {
    expect(SubscriptionPressureStatusInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects stale_after_seconds at zero", () => {
    expect(
      SubscriptionPressureStatusInputSchema.safeParse({ stale_after_seconds: 0 }).success,
    ).toBe(false);
  });
});

describe("subscription_pressure_status handler", () => {
  it("returns expired_window warnings from persisted pressure through the MCP handler", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db);
    new T0Writer(db).write(
      T0EventSchema.parse({
        event_id: "expired",
        ts: "2026-09-14T21:28:11Z",
        ingest_ts: "2026-09-14T21:28:11Z",
        source: "agentchat",
        source_detail: null,
        project_id: null,
        user_id: "u",
        machine_id: "m",
        session_id: null,
        event_type: "rate-limit-snapshot",
        lane: "cli-subscription",
        provider: "openai",
        model: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        latency_ms: null,
        request_id: null,
        payload_summary: null,
        origin: null,
        payload_json: {
          window_label: "secondary",
          model: null,
          used_pct: 98,
          resets_at: 1789813384,
          source_kind: "local-state-codex-rollout",
        },
      }),
    );
    const handler = subscriptionPressureStatusHandler(
      fakeDaemon({
        subscriptionPressureStatus: (input) =>
          Promise.resolve(
            readSubscriptionPressure(db, {
              ...input,
              now: () => new Date("2026-10-01T12:00:00Z"),
            }),
          ),
      }),
    );
    try {
      const out = await handler({ provider: "openai" });
      const block = out.content[0];
      if (!block) throw new Error("expected text content");
      expect(JSON.parse(block.text)).toEqual({
        snapshots: [],
        warnings: [
          {
            code: "expired_window",
            provider: "openai",
            window_label: "secondary",
            model: null,
            age_seconds: 1434709,
            expired_for_seconds: 1042616,
          },
        ],
      });
    } finally {
      db.close();
    }
  });

  it("forwards input and returns JSON text", async () => {
    const calls: SubscriptionPressureStatusReq[] = [];
    const subscriptionPressureStatus: SubscriptionPressureStatusFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        snapshots: [
          {
            provider: "openai",
            window_label: "24h",
            observed_at: "2026-05-07T00:00:00Z",
            state: "warning",
          },
        ],
        warnings: [],
      });
    };
    const handler = subscriptionPressureStatusHandler(fakeDaemon({ subscriptionPressureStatus }));

    const out = await handler({ provider: "openai", stale_after_seconds: 1800 });
    expect(calls).toEqual([{ provider: "openai", stale_after_seconds: 1800 }]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    expect(JSON.parse(block.text)).toEqual({
      snapshots: [
        {
          provider: "openai",
          window_label: "24h",
          observed_at: "2026-05-07T00:00:00Z",
          state: "warning",
        },
      ],
      warnings: [],
    });
  });
});

describe("tool registry entry", () => {
  it("registers subscription_pressure_status as read only", () => {
    const entry = TOOL_REGISTRY["subscription_pressure_status"];
    expect(entry).toBeDefined();
    expect(entry?.readOnly).toBe(true);
  });
});
