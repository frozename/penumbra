import { describe, expect, test } from "bun:test";

import { type ChainSendTargetHandoff, selectChainSendTarget } from "@src/lib/chain-send-target.js";

function row(
  handoff_id: string,
  overrides: Partial<Omit<ChainSendTargetHandoff, "handoff_id">> = {},
): ChainSendTargetHandoff {
  return {
    handoff_id,
    conversation_id: "c1",
    status: "dispatched",
    cancel_requested_at: null,
    ...overrides,
  };
}

describe("selectChainSendTarget", () => {
  test("returns the handoff_id when latest and a single matching dispatched row agree", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, [row("h1")])).toBe("h1");
  });

  test("returns null for zero dispatched rows", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, [])).toBeNull();
  });

  test("returns null for multiple dispatched rows", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, [row("h1"), row("h2")])).toBeNull();
  });

  test("returns null for duplicate same-id rows", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, [row("h1"), row("h1")])).toBeNull();
  });

  test("returns null when dispatched handoff_id does not match latest", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, [row("h2")])).toBeNull();
  });

  test("returns null when dispatched conversation_id does not match", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, [row("h1", { conversation_id: "c2" })])).toBeNull();
  });

  test("returns null when latest is a terminal status", () => {
    for (const status of [
      "pending",
      "approved",
      "rejected",
      "completed",
      "failed",
      "expired",
    ] as const) {
      const latest = row("h1", { status });
      expect(selectChainSendTarget("c1", latest, [row("h1")])).toBeNull();
    }
  });

  test("returns null when latest has a cancellation request", () => {
    const latest = row("h1", { cancel_requested_at: "2026-05-08T00:00:00Z" });
    expect(selectChainSendTarget("c1", latest, [row("h1")])).toBeNull();
  });

  test("returns null when the active dispatched row has a cancellation request", () => {
    const latest = row("h1");
    expect(
      selectChainSendTarget("c1", latest, [
        row("h1", { cancel_requested_at: "2026-05-08T00:00:00Z" }),
      ]),
    ).toBeNull();
  });

  test("returns null when latest is absent", () => {
    expect(selectChainSendTarget("c1", null, [row("h1")])).toBeNull();
    expect(selectChainSendTarget("c1", undefined, [row("h1")])).toBeNull();
  });

  test("returns null when dispatched array is absent", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("c1", latest, undefined)).toBeNull();
  });

  test("returns null for empty conversation or handoff id", () => {
    const latest = row("h1");
    expect(selectChainSendTarget("", latest, [row("h1")])).toBeNull();
    expect(selectChainSendTarget("c1", row(""), [row("")])).toBeNull();
  });

  test("returns null when latest conversation_id does not match the supplied conversation", () => {
    const latest = row("h1", { conversation_id: "c2" });
    expect(selectChainSendTarget("c1", latest, [row("h1", { conversation_id: "c2" })])).toBeNull();
  });

  test("returns null when the active row is not dispatched", () => {
    for (const status of [
      "pending",
      "approved",
      "rejected",
      "completed",
      "failed",
      "expired",
    ] as const) {
      expect(selectChainSendTarget("c1", row("h1"), [row("h1", { status })])).toBeNull();
    }
  });
});
