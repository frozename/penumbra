import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import type { DispatchOutput } from "@src/sdk/adapter.js";
import type { NotificationEvent } from "@src/worker/capture-port.js";

import { makeMockCapturePort } from "../helpers/stdio-acp-fixtures.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDir, "../fixtures/acp-codex-phases.ts");

/**
 * Round-trip coverage for codex-acp `_meta.codex.phase` handling, driven over a
 * REAL spawned bun subprocess (test/fixtures/acp-codex-phases.ts) speaking ACP
 * JSON-RPC over real stdio pipes through the real StdioAcpClient — no mocked
 * transport. The adapter is constructed with default deps so startServer and
 * the wire client are the production implementations.
 *
 * fsReadTextFile: true advertises a client capability so tool_call session
 * updates exercise the real handler path instead of the no-capability kill.
 */

interface PhaseHarness {
  adapter: StdioAcpAdapter;
  emitted: NotificationEvent[];
}

function makePhaseAdapter(mode: string, extra: { modelWarmupPrompt?: string } = {}): PhaseHarness {
  const emitted: NotificationEvent[] = [];
  const capturePort = makeMockCapturePort({
    emit: (ev: NotificationEvent): void => {
      emitted.push(ev);
    },
  });
  const adapter = new StdioAcpAdapter({
    binary: "bun",
    args: [fixture],
    cwd: process.cwd(),
    env: { ACP_PHASE_MODE: mode },
    fsReadTextFile: true,
    capturePort,
    ...extra,
  });
  return { adapter, emitted };
}

function dispatchOnce(
  adapter: StdioAcpAdapter,
  events?: DispatchEventInput[],
): Promise<DispatchOutput> {
  return adapter.dispatch({
    prompt: "review the diff",
    conversation: { id: "c-phase", project_id: null },
    config: {},
    signal: new AbortController().signal,
    handoff_id: "h-phase",
    eventContext: { handoffId: "h-phase", workerId: "w-phase" },
    onEvent: (e) => {
      events?.push(e);
    },
  });
}

describe("stdio-acp codex _meta.codex.phase separation (real subprocess)", () => {
  test("phased turn: response is the final_answer chunks only; commentary still streams", async () => {
    const { adapter, emitted } = makePhaseAdapter("phased");

    const result = await dispatchOnce(adapter);

    expect(result.text).toBe("NO_BUGS");
    const messageChunks = emitted.flatMap((ev) =>
      ev.kind === "agent_message_chunk" && typeof ev.content === "string" ? [ev.content] : [],
    );
    expect(messageChunks).toEqual(["I'll check the callers first.", "NO_BUGS"]);
    expect(emitted.some((ev) => ev.kind === "tool_call" && ev.toolCallId === "tc-1")).toBe(true);
  }, 10_000);

  test("mixed turn: null/absent-phase chunks are excluded when a final_answer exists", async () => {
    const { adapter } = makePhaseAdapter("mixed");

    const result = await dispatchOnce(adapter);

    expect(result.text).toBe("THE_ANSWER");
  }, 10_000);

  test("no_final turn: phases but no final_answer falls back to full concatenation + warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events: DispatchEventInput[] = [];
      const { adapter } = makePhaseAdapter("no_final");

      const result = await dispatchOnce(adapter, events);

      expect(result.text).toBe("work log.orphan text");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("no non-whitespace final_answer text"),
        expect.anything(),
      );
      // The warning carries the handoff id (never message content).
      expect(String(warn.mock.calls[0]?.[0])).toContain("h-phase");
      // ...and the drift surfaces as a dispatch event, not just a console line.
      expect(events.some((e) => e.kind === "acp.phase.drift" && e.handoff_id === "h-phase")).toBe(
        true,
      );
      expect(events.filter((e) => e.kind === "acp.phase.drift")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  }, 10_000);

  test("unphased turn: no _meta anywhere keeps full concatenation (non-codex agents)", async () => {
    const { adapter } = makePhaseAdapter("unphased");

    const result = await dispatchOnce(adapter);

    expect(result.text).toBe("foobar");
  }, 10_000);

  test("model warmup turn cannot leak its final_answer into the task response", async () => {
    const { adapter } = makePhaseAdapter("warmup", { modelWarmupPrompt: "warmup please" });

    const result = await dispatchOnce(adapter);

    expect(result.text).toBe("TASK_RESULT");
  }, 10_000);

  test("multi-prompt: turn-1 final_answer does not leak into a commentary-only turn-2", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events: DispatchEventInput[] = [];
      const { adapter } = makePhaseAdapter("warmup_drift", {
        modelWarmupPrompt: "warmup please",
      });

      const result = await dispatchOnce(adapter, events);

      // Turn 2 streamed commentary only — with the per-turn phase reset the
      // response is turn-2's text (fail-open), NOT turn-1's STALE_WARMUP_ANSWER.
      expect(result.text).toBe("task narration.");
      expect(events.filter((e) => e.kind === "acp.phase.drift")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  }, 10_000);

  test("trailing commentary after a final_answer chunk is excluded from the response", async () => {
    const { adapter, emitted } = makePhaseAdapter("trailing");

    const result = await dispatchOnce(adapter);

    expect(result.text).toBe("FOUND_ANSWER");
    const messageChunks = emitted.flatMap((ev) =>
      ev.kind === "agent_message_chunk" && typeof ev.content === "string" ? [ev.content] : [],
    );
    expect(messageChunks).toEqual(["FOUND_ANSWER", "post-answer narration."]);
  }, 10_000);

  test("empty final_answer chunk falls back to the full concatenation", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events: DispatchEventInput[] = [];
      const { adapter } = makePhaseAdapter("empty_final");

      const result = await dispatchOnce(adapter, events);

      expect(result.text).toBe("progress note.");
      expect(events.some((e) => e.kind === "acp.phase.drift")).toBe(true);
      expect(events.filter((e) => e.kind === "acp.phase.drift")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  }, 10_000);

  test("no chunks at all: response stays empty and no drift is reported", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events: DispatchEventInput[] = [];
      const { adapter } = makePhaseAdapter("silent");

      const result = await dispatchOnce(adapter, events);

      expect(result.text).toBe("");
      expect(events.some((e) => e.kind === "acp.phase.drift")).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 10_000);

  test("whitespace-only final_answer falls back to the full concatenation", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events: DispatchEventInput[] = [];
      const { adapter } = makePhaseAdapter("whitespace_final");

      const result = await dispatchOnce(adapter, events);

      expect(result.text).toBe("progress note.  \n");
      expect(events.filter((e) => e.kind === "acp.phase.drift")).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  }, 10_000);

  test("error path does not report phase drift for an unrecorded response", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events: DispatchEventInput[] = [];
      const { adapter } = makePhaseAdapter("error_phased");

      let caught: unknown;
      try {
        await dispatchOnce(adapter, events);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      if (!(caught instanceof Error)) throw new Error("expected dispatch failure");
      expect(caught.message).toContain("prompt exploded");
      expect(events.filter((e) => e.kind === "acp.phase.drift")).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 10_000);
});
