import { describe, expect, test } from "bun:test";

import * as lib from "../src/index.ts";
import { type FakeAcp, requestsTo, startFakeAcp, stopFakeAcp } from "./helpers.ts";

interface DecideCall {
  toolName: string;
  rawInput: unknown;
  sessionId: string;
}

async function bootedFake(
  decide?: (req: DecideCall) => Promise<"approve" | "reject"> | "approve" | "reject",
  signal?: AbortSignal,
): Promise<{
  fake: FakeAcp;
  outcomes: lib.PermissionResult[];
  decideCalls: DecideCall[];
  promptDone: Promise<unknown>;
}> {
  const fake = await startFakeAcp("perm", { FAKE_ACP_ASK_PERMISSION: "1" });
  const outcomes: lib.PermissionResult[] = [];
  const decideCalls: DecideCall[] = [];
  const context = new lib.StdioAcpPermissionContext();
  const session = await lib.initializeAcpSession({
    client: fake.client,
    clientInfo: { name: "perm-probe", version: "0.0.0" },
    clientCapabilities: {},
    protocolVersion: 1,
    cwd: fake.dir,
    bootDeadlineMs: 5_000,
    signal: new AbortController().signal,
  });
  context.activate(session.sessionId);

  const host: lib.PermissionHost = {
    signal: signal ?? new AbortController().signal,
    dispatchId: "dispatch-perm-1",
    ...(decide === undefined
      ? {}
      : {
          decide: async (req: DecideCall): Promise<"approve" | "reject"> => {
            decideCalls.push(req);
            return await decide(req);
          },
        }),
  };
  fake.client.onRequest("session/request_permission", async (params) => {
    const outcome = await lib.handleStdioAcpPermissionRequest(host, context, params);
    outcomes.push(outcome);
    return outcome;
  });
  const promptDone = fake.client.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "go" }],
  });
  return { fake, outcomes, decideCalls, promptDone };
}

describe("[PERM] permission requests over a real ACP transport", () => {
  test("[PERM] a host without decide cancels the request (deny by default)", async () => {
    const { fake, outcomes, promptDone } = await bootedFake();
    try {
      await promptDone;
      expect(outcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
      const responses = requestsTo(fake.logPath, "session/request_permission");
      expect(responses).toHaveLength(1);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] a throwing decide selects reject_once", async () => {
    const { fake, outcomes, promptDone } = await bootedFake(() => {
      throw new Error("decider exploded");
    });
    try {
      await promptDone;
      expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "reject_once" } }]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] decide receives toolName, rawInput and sessionId from the wire", async () => {
    const { fake, outcomes, decideCalls, promptDone } = await bootedFake(() => "approve");
    try {
      await promptDone;
      expect(decideCalls).toEqual([
        {
          toolName: "fake/tool",
          rawInput: { command: "fake-cmd", note: "from fake-acp" },
          sessionId: "fake-session-1",
        },
      ]);
      expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] an aborted signal cancels before decide runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fake, outcomes, decideCalls, promptDone } = await bootedFake(
      () => "approve",
      controller.signal,
    );
    try {
      await promptDone;
      expect(decideCalls).toHaveLength(0);
      expect(outcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] selectConfigOption and selectTrustAllOption are pure exported helpers", () => {
    const options = [
      { kind: "allow_always", optionId: "switch_bypass" },
      { kind: "allow_once", optionId: "allow_once" },
      { kind: "reject_once", optionId: "reject_once" },
    ];
    expect(lib.selectConfigOption(options, "approve")?.optionId).toBe("allow_once");
    expect(lib.selectConfigOption(options, "reject")?.optionId).toBe("reject_once");
    expect(lib.selectConfigOption(options, "approve")).toEqual(
      lib.selectConfigOption(options, "approve"),
    );
    expect(lib.selectTrustAllOption(options)?.optionId).toBe("switch_bypass");
  });
});
