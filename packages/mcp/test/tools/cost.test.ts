import type { DaemonClient } from "@src/daemon-client.js";

import {
  costQuotaStatusHandler,
  CostQuotaStatusInputSchema,
} from "@src/tools/cost-quota-status.js";
import { costRecentHandler, CostRecentInputSchema } from "@src/tools/cost-recent.js";
import { describe, expect, it } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type CostRecentFn = DaemonClient["costRecent"];
type CostRecentReq = Parameters<CostRecentFn>[0];
type CostQuotaStatusFn = DaemonClient["costQuotaStatus"];
type CostQuotaStatusReq = Parameters<CostQuotaStatusFn>[0];

function firstBlockText(envelope: { content: { type: "text"; text: string }[] }): string {
  const block = envelope.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  return block.text;
}

describe("cost.recent input schema", () => {
  it("accepts no arguments", () => {
    expect(CostRecentInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects invalid since", () => {
    expect(CostRecentInputSchema.safeParse({ since: "not-a-date" }).success).toBe(false);
  });
});

describe("cost.quota_status input schema", () => {
  it("accepts no arguments", () => {
    expect(CostQuotaStatusInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("cost.recent handler", () => {
  it("forwards filters and returns summary plus JSON text", async () => {
    const calls: CostRecentReq[] = [];
    const costRecent: CostRecentFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        total_cost_usd: 1.25,
        total_tokens_used: 42,
        handoff_count: 1,
        by_provider: [
          {
            provider: "anthropic",
            cost_usd: 1.25,
            cost_usd_billed: 0.5,
            cost_usd_synth: 0.75,
            tokens_used: 42,
            handoff_count: 1,
            subscription_pressure: [
              {
                window_label: "five_hour",
                used_pct: 55,
                observed_at: "2026-05-08T11:45:00Z",
                source_kind: "local-state",
                resets_at: 1778166000,
              },
              {
                window_label: "daily",
                used_pct: 0,
                observed_at: "2026-05-08T11:40:00Z",
                source_kind: "local-state",
                resets_at: null,
              },
            ],
          },
        ],
        by_provider_model: [],
        window: { from: "a", to: "b" },
      });
    };
    const handler = costRecentHandler(fakeDaemon({ costRecent }));

    const out = await handler({ since: "2026-04-28T00:00:00Z", project_id: "proj-1" });
    expect(calls).toEqual([{ since: "2026-04-28T00:00:00Z", project_id: "proj-1" }]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    const rendered = JSON.parse(block.text) as string;
    expect(rendered).toContain("● cost.recent");
    expect(rendered).toContain("◐ anthropic pressure five_hour:55%");
    expect(rendered).not.toContain("daily:0%");
    const [, jsonText] = rendered.split("\n\n");
    expect(JSON.parse(jsonText ?? "")).toEqual({
      total_cost_usd: 1.25,
      total_tokens_used: 42,
      handoff_count: 1,
      by_provider: [
        {
          provider: "anthropic",
          cost_usd: 1.25,
          cost_usd_billed: 0.5,
          cost_usd_synth: 0.75,
          tokens_used: 42,
          handoff_count: 1,
          subscription_pressure: [
            {
              window_label: "five_hour",
              used_pct: 55,
              observed_at: "2026-05-08T11:45:00Z",
              source_kind: "local-state",
              resets_at: 1778166000,
            },
            {
              window_label: "daily",
              used_pct: 0,
              observed_at: "2026-05-08T11:40:00Z",
              source_kind: "local-state",
              resets_at: null,
            },
          ],
        },
      ],
      by_provider_model: [],
      window: { from: "a", to: "b" },
    });
  });
});

describe("cost.quota_status handler", () => {
  it("forwards since and returns JSON text", async () => {
    const calls: CostQuotaStatusReq[] = [];
    const costQuotaStatus: CostQuotaStatusFn = (input) => {
      calls.push(input);
      return Promise.resolve({ window: { from: "a", to: "b" }, providers: [] });
    };
    const handler = costQuotaStatusHandler(fakeDaemon({ costQuotaStatus }));

    const out = await handler({ since: "2026-04-28T00:00:00Z" });
    expect(calls).toEqual([{ since: "2026-04-28T00:00:00Z" }]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block.type).toBe("text");
    expect(JSON.parse(firstBlockText(out))).toEqual({
      window: { from: "a", to: "b" },
      providers: [],
    });
  });
});
