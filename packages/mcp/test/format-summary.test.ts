import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  dimColor,
  formatChainGetResponse,
  formatChainStart,
  formatChainStatus,
  formatChainWait,
  formatElapsed,
  formatHandoffGet,
  formatHandoffListPending,
  formatPermissionApprove,
  formatPermissionListPending,
  glyphFor,
  truncateId,
  wrapWithSummary,
} from "../src/format-summary.js";

describe("format-summary utilities", () => {
  let savedNoColor: string | undefined;
  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
  });
  afterEach(() => {
    if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
    else delete process.env.NO_COLOR;
  });

  test("dimColor wraps in ANSI dim sequence", () => {
    expect(dimColor("h-7d3a91")).toBe("\x1b[2mh-7d3a91\x1b[0m");
  });

  test("dimColor returns plain text when NO_COLOR=1", () => {
    process.env.NO_COLOR = "1";
    expect(dimColor("h-7d3a91")).toBe("h-7d3a91");
  });

  test("truncateId truncates with ellipsis at given length", () => {
    expect(truncateId("h-7d3a91ab1234567890", 8)).toBe("h-7d3a91…");
    expect(truncateId("short", 20)).toBe("short");
  });

  test("formatElapsed handles seconds, minutes, hours, days", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(47_000)).toBe("47s");
    expect(formatElapsed(192_000)).toBe("3m12s");
    expect(formatElapsed(8_040_000)).toBe("2h 14m");
    expect(formatElapsed(100_000_000)).toBe("1d 4h");
  });

  test("glyphFor maps statuses to glyphs", () => {
    expect(glyphFor("dispatched")).toBe("◌");
    expect(glyphFor("pending")).toBe("◐");
    expect(glyphFor("completed")).toBe("●");
    expect(glyphFor("approved")).toBe("●");
    expect(glyphFor("failed")).toBe("◑");
    expect(glyphFor("rejected")).toBe("◑");
    expect(glyphFor("cancelled")).toBe("◑");
    expect(glyphFor("expired")).toBe("◑");
    expect(glyphFor("unknown")).toBe("●"); // safe default
  });
});

describe("per-tool formatters", () => {
  beforeEach(() => {
    process.env.NO_COLOR = "1";
  }); // simplify golden strings
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  test("formatChainStart", () => {
    expect(
      formatChainStart({
        conversation_id: "conv-abc",
        handoff_id: "7d3a91ab-1234-5678",
        agent: "claude-acp-sonnet",
        trust_mode: "config",
      }),
    ).toBe("◌ chain_start  claude-acp-sonnet  h-7d3a91a…  trust=config");
  });

  test("formatChainStatus dispatched", () => {
    expect(
      formatChainStatus({
        handoff_id: "7d3a91ab-1234-5678",
        status: "dispatched",
        worker_id: "worker-b",
        started_at: new Date(Date.now() - 192_000).toISOString(),
        resolved_at: null,
        error_summary: null,
      }),
    ).toBe("◌ chain_status  h-7d3a91a…  dispatched on worker-b  3m12s");
  });

  test("formatChainStatus completed", () => {
    expect(
      formatChainStatus({
        handoff_id: "7d3a91ab-1234-5678",
        status: "completed",
        worker_id: "worker-b",
        started_at: new Date(Date.now() - 247_000).toISOString(),
        resolved_at: new Date().toISOString(),
        error_summary: null,
      }),
    ).toMatch(/^● chain_status {2}h-7d3a91a… {2}completed on worker-b {2}/);
  });

  test("formatChainWait", () => {
    expect(
      formatChainWait(
        {
          status: "completed",
          last_handoff_id: "7d3a91ab-1234-5678",
          // simulating elapsed via test-supplied field if needed; otherwise the formatter uses Date math
        },
        247_000,
      ),
    ).toBe("● chain_wait  h-7d3a91a…  completed in 4m07s");
  });

  test("formatChainGetResponse single", () => {
    expect(
      formatChainGetResponse({
        responses: [{ ts: "...", agent: "claude-acp-sonnet", text: "..." }],
      }),
    ).toBe("● chain_get_response  claude-acp-sonnet  1 response");
  });

  test("formatChainGetResponse includes handoff_id prefix when present", () => {
    expect(
      formatChainGetResponse({
        responses: [
          {
            ts: "...",
            agent: "claude-acp-sonnet",
            text: "...",
            handoff_id: "7d3a91ab-1234-5678",
          },
        ],
      }),
    ).toBe("● chain_get_response  claude-acp-sonnet  h-7d3a91a…  1 response");
  });

  test("formatChainGetResponse plural", () => {
    expect(
      formatChainGetResponse({
        responses: [
          { ts: "...", agent: "claude-acp-sonnet", text: "..." },
          { ts: "...", agent: "claude-acp-sonnet", text: "..." },
        ],
      }),
    ).toBe("● chain_get_response  claude-acp-sonnet  2 responses");
  });

  test("formatHandoffGet", () => {
    expect(
      formatHandoffGet({
        handoff: {
          handoff_id: "7d3a91ab-1234-5678",
          to_agent: "codex-mini",
          status: "dispatched",
        },
      }),
    ).toBe("◌ handoff  h-7d3a91a…  codex-mini  dispatched");
  });

  test("formatHandoffListPending populated", () => {
    expect(
      formatHandoffListPending({
        handoffs: [
          { handoff_id: "h1", worker_id: "worker-primary", status: "dispatched" },
          { handoff_id: "h2", worker_id: "worker-b", status: "dispatched" },
          { handoff_id: "h3", worker_id: "worker-b", status: "dispatched" },
        ],
      }),
    ).toBe("◌ handoff_list_pending  3 entries  worker-primary:1, worker-b:2");
  });

  test("formatHandoffListPending empty", () => {
    expect(formatHandoffListPending({ handoffs: [] })).toBe("● handoff_list_pending  no pending");
  });

  test("formatPermissionListPending populated", () => {
    const oldestAt = Date.now() - 720_000;
    expect(
      formatPermissionListPending({
        permissions: [
          { permission_id: "p1", requested_at: new Date(oldestAt).toISOString() },
          { permission_id: "p2", requested_at: new Date(Date.now() - 60_000).toISOString() },
        ],
      }),
    ).toMatch(/^◐ permission_list_pending {2}2 pending {2}oldest 12m/);
  });

  test("formatPermissionListPending empty", () => {
    expect(formatPermissionListPending({ permissions: [] })).toBe(
      "● permission_list_pending  no pending",
    );
  });

  test("formatPermissionApprove approve", () => {
    expect(
      formatPermissionApprove({
        permission_id: "abc123def456",
        status: "approved",
        decision: "approve",
        remember: "this_dispatch",
      }),
    ).toBe("● permission  abc123…  approve  remember=this_dispatch");
  });

  test("formatPermissionApprove reject", () => {
    expect(
      formatPermissionApprove({
        permission_id: "abc123def456",
        status: "rejected",
        decision: "reject",
        remember: "this_call",
      }),
    ).toBe("◑ permission  abc123…  reject  remember=this_call");
  });

  test("wrapWithSummary combines header + JSON", () => {
    const result = wrapWithSummary("◌ chain_status  h-abc…  dispatched", { foo: 1 });
    expect(result).toBe('◌ chain_status  h-abc…  dispatched\n\n{\n  "foo": 1\n}');
  });
});
