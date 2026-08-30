import type { SpawnOptionsWithoutStdio } from "node:child_process";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  type AcpSessionSpawner,
  discoverAcpSessionModels,
  parseAcpSessionModels,
  runAcpHandshake,
} from "@src/commands/generator/discovery-acp-session.js";

import { expectAsyncThrow } from "../_helpers.js";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const fixturePath = join(import.meta.dir, "../fixtures/acp-session-handshake.jsonl");
const fixtureLines = readFileSync(fixturePath, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as RpcMessage);
const initializeFixture = fixtureLines[0]!;
const sessionFixture = fixtureLines[1]!;
const notificationFixture = fixtureLines[2]!;

class FakeAcpChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly requests: RpcMessage[] = [];
  private input = "";

  readonly kill = mock((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : null;
    queueMicrotask(() => {
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
    });
    return true;
  });

  constructor(onRequest: (request: RpcMessage, child: FakeAcpChild) => void, pid = 4242) {
    super();
    this.pid = pid;
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.input += chunk;
      for (;;) {
        const newline = this.input.indexOf("\n");
        if (newline < 0) break;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line.trim().length === 0) continue;
        const request = JSON.parse(line) as RpcMessage;
        this.requests.push(request);
        onRequest(request, this);
      }
    });
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function responseFor(request: RpcMessage, fixture: RpcMessage): RpcMessage {
  return { ...fixture, id: request.id };
}

function handshakeChild(
  options: {
    sessionResult?: unknown;
    interleaveNotification?: boolean;
    pid?: number;
  } = {},
): FakeAcpChild {
  let initialized = false;
  return new FakeAcpChild((request, child) => {
    if (request.method === "initialize") {
      initialized = true;
      child.send(responseFor(request, initializeFixture));
      return;
    }
    if (request.method === "session/new") {
      if (!initialized) {
        child.send({
          jsonrpc: "2.0",
          id: request.id,
          result: undefined,
          error: { code: -32000, message: "initialize must be sent first" },
        } as RpcMessage);
        return;
      }
      if (options.interleaveNotification === true) child.send(notificationFixture);
      child.send(
        responseFor(request, {
          ...sessionFixture,
          ...(options.sessionResult === undefined ? {} : { result: options.sessionResult }),
        }),
      );
    }
  }, options.pid);
}

function spawnChild(child: FakeAcpChild): AcpSessionSpawner {
  return mock(() => child as unknown as ReturnType<AcpSessionSpawner>);
}

afterEach(() => {
  delete process.env.PENUMBRA_ACP_DISCOVERY_KEEP;
  delete process.env.PENUMBRA_ACP_DISCOVERY_UNSET;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
});

describe("ACP session model discovery", () => {
  test("runAcpHandshake sends initialize before session/new over the injected transport and resolves with the session/new result", async () => {
    const child = handshakeChild();

    const result = await runAcpHandshake({
      command: "fixture-acp",
      args: ["serve"],
      spawn: spawnChild(child),
      timeoutMs: 100,
    });

    expect(result).toEqual(sessionFixture.result);
    expect(child.requests.map((request) => request.method)).toEqual(["initialize", "session/new"]);
  });

  test("parseAcpSessionModels extracts every availableModels entry; currentModelId is a hint, never the sole model", () => {
    const models = parseAcpSessionModels(sessionFixture.result, "openai");

    expect(models).toHaveLength(21);
    expect(models[0]).toEqual({
      sourceProviderId: "openai",
      modelId: "gpt-5.3-codex-spark",
      displayName: "gpt-5.3-codex-spark",
    });
    expect(models).toContainEqual({
      sourceProviderId: "openai",
      modelId: "gpt-5.5/low",
      displayName: "GPT-5.5 (low)",
      metadata: {
        description:
          "Frontier model for complex coding, research, and real-world work. Fast responses with lighter reasoning",
      },
    });
    expect(models.find((model) => model.modelId === "gpt-5.5/low")?.reasoningTier).toBeUndefined();
  });

  test("a handshake that never advertises models returns a skip with a reason, not a throw and not a silent empty success", async () => {
    const child = handshakeChild({ sessionResult: { sessionId: "session-without-models" } });

    const result = await discoverAcpSessionModels({
      providerId: "anthropic",
      command: "fixture-acp",
      args: [],
      spawn: spawnChild(child),
      timeoutMs: 100,
    });

    expect(result).toEqual({
      outcome: "skipped",
      reason: "ACP session handshake did not advertise any available models",
    });
  });

  test("a child that hangs on session/new is killed within timeoutMs and confirmed dead", async () => {
    const child = new FakeAcpChild((request, transport) => {
      if (request.method === "initialize") {
        transport.send(responseFor(request, initializeFixture));
      }
    }, 7331);
    const infoCalls: unknown[][] = [];
    // eslint-disable-next-line no-console -- the test captures required info-level lifecycle logs.
    const originalInfo = console.info;
    // eslint-disable-next-line no-console -- the test captures required info-level lifecycle logs.
    console.info = (...args: unknown[]): void => {
      infoCalls.push(args);
    };
    const startedAt = performance.now();

    try {
      await expectAsyncThrow(
        runAcpHandshake({
          command: "fixture-acp",
          args: [],
          spawn: spawnChild(child),
          timeoutMs: 20,
        }),
        "session/new timed out after 20ms",
      );
    } finally {
      // eslint-disable-next-line no-console -- restore the captured info logger.
      console.info = originalInfo;
    }

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
    expect(infoCalls).toContainEqual(["acp-session discovery spawned", { pid: 7331 }]);
    expect(infoCalls).toContainEqual([
      "acp-session discovery exited",
      { pid: 7331, exitCode: null, signalCode: "SIGKILL" },
    ]);
  });

  test("the probe scrubs CLAUDE_* from the inherited env before spawning", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "nested-harness";
    process.env.PENUMBRA_ACP_DISCOVERY_KEEP = "keep-me";
    const child = handshakeChild();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const implementation: AcpSessionSpawner = (
      _command: string,
      _args: readonly string[],
      options: SpawnOptionsWithoutStdio,
    ) => {
      spawnedEnv = options.env;
      return child as unknown as ReturnType<AcpSessionSpawner>;
    };
    const spawn: AcpSessionSpawner = mock<AcpSessionSpawner>(implementation);

    await runAcpHandshake({
      command: "fixture-acp",
      args: [],
      spawn,
      timeoutMs: 100,
    });

    expect(spawnedEnv?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(spawnedEnv?.PENUMBRA_ACP_DISCOVERY_KEEP).toBe("keep-me");
  });

  test("explicit unsetEnv keys are removed only from the spawned env", async () => {
    process.env.PENUMBRA_ACP_DISCOVERY_UNSET = "remove-from-child";
    process.env.PENUMBRA_ACP_DISCOVERY_KEEP = "keep-me";
    const child = handshakeChild();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const implementation: AcpSessionSpawner = (
      _command: string,
      _args: readonly string[],
      options: SpawnOptionsWithoutStdio,
    ) => {
      spawnedEnv = options.env;
      return child as unknown as ReturnType<AcpSessionSpawner>;
    };
    const spawn: AcpSessionSpawner = mock<AcpSessionSpawner>(implementation);

    await runAcpHandshake({
      command: "fixture-acp",
      args: [],
      spawn,
      timeoutMs: 100,
      unsetEnv: ["PENUMBRA_ACP_DISCOVERY_UNSET"],
    });

    expect(spawnedEnv?.PENUMBRA_ACP_DISCOVERY_UNSET).toBeUndefined();
    expect(spawnedEnv?.PENUMBRA_ACP_DISCOVERY_KEEP).toBe("keep-me");
    expect(process.env.PENUMBRA_ACP_DISCOVERY_UNSET).toBe("remove-from-child");
  });

  test("no session/prompt is ever sent", async () => {
    const child = handshakeChild();

    await runAcpHandshake({
      command: "fixture-acp",
      args: [],
      spawn: spawnChild(child),
      timeoutMs: 100,
    });

    expect(child.requests.some((request) => request.method === "session/prompt")).toBe(false);
    expect(child.requests.map((request) => request.method)).toEqual(["initialize", "session/new"]);
  });

  test("interleaved notifications (session/update) are tolerated and never mistaken for the session/new reply", async () => {
    const child = handshakeChild({ interleaveNotification: true });

    const result = await runAcpHandshake({
      command: "fixture-acp",
      args: [],
      spawn: spawnChild(child),
      timeoutMs: 100,
    });

    expect(result).toEqual(sessionFixture.result);
    expect((result as { sessionId?: unknown }).sessionId).toBe(
      "01a03f47-4ba1-7482-aaa1-f9535cfc9d2e",
    );
  });
});
