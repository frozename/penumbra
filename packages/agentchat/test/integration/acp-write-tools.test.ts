import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import type { DispatchInput } from "../../src/sdk/adapter.js";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "../../src/worker/sandbox-config.js";
import { WriteToolsExecutor } from "../../src/worker/write-tools-executor.js";

type PermissionDecision = "approve" | "reject";

interface CapturedEvent {
  type: string;
  payload: unknown;
}

interface HarnessOptions {
  fsWriteTextFile?: boolean;
  terminal?: boolean;
  permissionDecision?: PermissionDecision;
  sandboxConfigOverrides?: Partial<SandboxConfig>;
}

interface MockAcpServer {
  sendRequest: (
    method: string,
    params?: unknown,
  ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  initializeParams: unknown;
  sessionParams: unknown;
  promptParams: unknown;
}

interface IntegrationHarness {
  adapter: StdioAcpAdapter;
  executor: WriteToolsExecutor;
  worktreeRoot: string;
  events: CapturedEvent[];
  server: MockAcpServer;
  setPromptHandler: (handler: (server: MockAcpServer, params: unknown) => Promise<unknown>) => void;
  runDispatch: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function createIntegrationHarness(opts: HarnessOptions = {}): Promise<IntegrationHarness> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "phase1d-acp-"));
  const events: CapturedEvent[] = [];
  const serverToAdapter = new PassThrough();
  const adapterToServer = new PassThrough();
  const pendingRequests = new Map<
    number,
    (response: { result?: unknown; error?: { code: number; message: string } }) => void
  >();
  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: async () => opts.permissionDecision ?? "approve",
    auditEmitter: {
      emit: async (type, payload) => {
        events.push({ type, payload });
      },
    },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG, ...(opts.sandboxConfigOverrides ?? {}) },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    handoffId: "h-int",
    dispatchId: "d-int",
  });

  let nextRequestId = 1;
  let initializeParams: unknown = null;
  let sessionParams: unknown = null;
  let promptParams: unknown = null;
  let promptHandler: ((server: MockAcpServer, params: unknown) => Promise<unknown>) | null = null;

  const sendLine = (message: unknown) => {
    serverToAdapter.write(`${JSON.stringify(message)}\n`);
  };

  const server: MockAcpServer = {
    async sendRequest(method: string, params?: unknown) {
      const id = nextRequestId++;
      const responsePromise = new Promise<{
        result?: unknown;
        error?: { code: number; message: string };
      }>((resolve) => {
        pendingRequests.set(id, resolve);
      });
      sendLine({ jsonrpc: "2.0", method, params, id });
      return responsePromise;
    },
    initializeParams,
    sessionParams,
    promptParams,
  };

  const stdinReader = createInterface({ input: adapterToServer, terminal: false });
  stdinReader.on("line", (line) => {
    void (async () => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as any;

      if (message.method !== undefined && message.id !== undefined) {
        if (message.method === "initialize") {
          initializeParams = message.params;
          server.initializeParams = initializeParams;
          sendLine({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
          return;
        }

        if (message.method === "authenticate") {
          sendLine({ jsonrpc: "2.0", id: message.id, result: {} });
          return;
        }

        if (message.method === "session/new") {
          sessionParams = message.params;
          server.sessionParams = sessionParams;
          sendLine({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-123" } });
          return;
        }

        if (message.method === "session/prompt") {
          promptParams = message.params;
          server.promptParams = promptParams;
          try {
            const result = promptHandler
              ? await promptHandler(server, message.params)
              : { stopReason: "end_turn" };
            sendLine({ jsonrpc: "2.0", id: message.id, result });
          } catch (error) {
            const err = error as Error & { code?: number };
            sendLine({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: err.code ?? -32000, message: err.message ?? String(error) },
            });
          }
          return;
        }

        sendLine({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }

      if (message.id !== undefined) {
        const pending = pendingRequests.get(Number(message.id));
        if (pending) {
          pendingRequests.delete(Number(message.id));
          pending(message);
        }
      }
    })().catch(() => {});
  });

  const adapter = new StdioAcpAdapter(
    {
      binary: "mock-acp",
      cwd: worktreeRoot,
      fsWriteTextFile: !!opts.fsWriteTextFile,
      terminal: !!opts.terminal,
    },
    {
      startServer: async () => ({
        stdin: adapterToServer,
        stdout: serverToAdapter,
        kill: () => {
          serverToAdapter.destroy();
          adapterToServer.destroy();
          stdinReader.close();
        },
        exited: Promise.resolve(0),
      }),
      createClient: (handle) =>
        new StdioAcpClient({
          stdin: handle.stdin,
          stdout: handle.stdout,
        }),
    },
  );

  const dispatchInput: DispatchInput = {
    prompt: "hello",
    signal: new AbortController().signal,
    conversation: { id: "conv-1", project_id: null },
    config: {},
    handoff_id: "h-int",
    executor,
  };

  return {
    adapter,
    executor,
    worktreeRoot,
    events,
    server,
    setPromptHandler: (handler) => {
      promptHandler = handler;
    },
    runDispatch: async () => {
      await adapter.dispatch(dispatchInput);
    },
    cleanup: async () => {
      await executor.dispose();
      stdinReader.close();
      serverToAdapter.destroy();
      adapterToServer.destroy();
      await rm(worktreeRoot, { recursive: true, force: true });
    },
  };
}

describe("ACP write-tools integration", () => {
  test("fsWriteTextFile advertises clientCapabilities.fs.writeTextFile during initialize", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async () => ({ stopReason: "end_turn" }));
      await harness.runDispatch();

      expect(harness.server.initializeParams).toEqual(
        expect.objectContaining({
          clientCapabilities: expect.objectContaining({
            fs: expect.objectContaining({
              writeTextFile: true,
            }),
          }),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file round-trip writes the file and returns an empty JSON-RPC result", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "notes.txt",
          content: "hello world",
        });
        expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();

      expect(harness.server.initializeParams).toEqual(
        expect.objectContaining({
          clientCapabilities: {
            fs: {
              writeTextFile: true,
            },
          },
        }),
      );
      expect(await readFile(join(harness.worktreeRoot, "notes.txt"), "utf8")).toBe("hello world");
      expect(harness.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "fs.write_applied",
            payload: expect.objectContaining({
              path: "notes.txt",
              bytes: 11,
              sha256: createHash("sha256").update("hello world").digest("hex"),
              prev_sha256: null,
              handoff_id: "h-int",
            }),
          }),
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file emits fs.write_applied with path, bytes, and sha256", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        await server.sendRequest("fs/write_text_file", {
          path: "audit.txt",
          content: "abc123",
        });
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();

      const event = harness.events.find((entry) => entry.type === "fs.write_applied");
      expect(event).toBeDefined();
      expect(event?.payload).toEqual(
        expect.objectContaining({
          path: "audit.txt",
          bytes: 6,
          sha256: createHash("sha256").update("abc123").digest("hex"),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file outside-worktree path maps to JSON-RPC code -32001", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "/etc/passwd",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32001);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file permission rejection maps to JSON-RPC code -32004", async () => {
    const harness = await createIntegrationHarness({
      fsWriteTextFile: true,
      permissionDecision: "reject",
    });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "denied.txt",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32004);
        expect(response.error?.message).toContain("permission denied");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal advertises clientCapabilities.terminal during initialize", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async () => ({ stopReason: "end_turn" }));
      await harness.runDispatch();

      expect(harness.server.initializeParams).toEqual(
        expect.objectContaining({
          clientCapabilities: expect.objectContaining({
            terminal: true,
          }),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with command 'echo hi' can be waited on and returns output 'hi'", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          command: "echo hi",
        });
        expect(created.error).toBeUndefined();
        const terminalId = (created.result as any).terminal_id;

        const waited = await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        expect(waited.error).toBeUndefined();
        expect((waited.result as any).exit_status.exitCode).toBe(0);

        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect(output.error).toBeUndefined();
        expect(((output.result as any).output as string).trim()).toBe("hi");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/output round-trip returns the captured output snapshot", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          command: "echo output",
        });
        const terminalId = (created.result as any).terminal_id;
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect((output.result as any).output.trim()).toBe("output");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/release cleans up a running terminal and removes it from the registry", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          command: "sleep 5",
        });
        const terminalId = (created.result as any).terminal_id;

        const released = await server.sendRequest("terminal/release", {
          terminal_id: terminalId,
        });
        expect(released.result).toEqual({});

        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect(output.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with args ['echo', 'X'] uses argv form and prints X", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          args: ["echo", "X"],
        });
        const terminalId = (created.result as any).terminal_id;
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect((output.result as any).output.trim()).toBe("X");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with command 'echo Y' uses shell command form and prints Y", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          command: "echo Y",
        });
        const terminalId = (created.result as any).terminal_id;
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect((output.result as any).output.trim()).toBe("Y");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create prefers argv over command when both are provided", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          args: ["echo", "preferred"],
          command: "echo ignored",
        });
        const terminalId = (created.result as any).terminal_id;
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect((output.result as any).output.trim()).toBe("preferred");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal create cap rejects the 4th concurrent create when maxConcurrent is 3", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        for (let i = 0; i < 3; i += 1) {
          const created = await server.sendRequest("terminal/create", {
            args: ["sleep", "5"],
          });
          expect(created.error).toBeUndefined();
        }

        const capped = await server.sendRequest("terminal/create", {
          args: ["echo", "blocked"],
        });
        expect(capped.error?.code).toBe(-32006);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/kill on a running terminal emits terminal.killed with reason=operator", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          args: ["sleep", "10"],
        });
        const terminalId = (created.result as any).terminal_id;

        const killed = await server.sendRequest("terminal/kill", {
          terminal_id: terminalId,
        });
        expect(killed.result).toEqual({});

        expect(
          harness.events.some(
            (entry) =>
              entry.type === "terminal.killed" && (entry.payload as any).reason === "operator",
          ),
        ).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/wait_for_exit after kill returns a terminating signal", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          args: ["sleep", "10"],
        });
        const terminalId = (created.result as any).terminal_id;

        await server.sendRequest("terminal/kill", {
          terminal_id: terminalId,
        });
        const waited = await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });

        const signal = (waited.result as any).exit_status.signal;
        expect(signal === "SIGTERM" || signal === "SIGKILL").toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/kill on an unknown id maps to JSON-RPC code -32005", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/kill", {
          terminal_id: "missing",
        });
        expect(response.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/output on an unknown id maps to JSON-RPC code -32005", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/output", {
          terminal_id: "missing",
        });
        expect(response.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/wait_for_exit on an unknown id maps to JSON-RPC code -32005", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: "missing",
        });
        expect(response.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/release on an unknown id is a no-op and returns an empty JSON-RPC result", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/release", {
          terminal_id: "missing",
        });
        expect(response.result).toEqual({});
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file to a directory path maps to JSON-RPC code -32002", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      await mkdir(join(harness.worktreeRoot, "adir"), { recursive: true });
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "adir",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32002);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file to a read-only parent path maps to JSON-RPC code -32003", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      const readonlyDir = join(harness.worktreeRoot, "readonly");
      await mkdir(readonlyDir, { recursive: true });
      await chmod(readonlyDir, 0o555);

      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "readonly/file.txt",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32003);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create truncates output when output_byte_limit is small", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          command: "yes",
          output_byte_limit: 4096,
        });
        const terminalId = (created.result as any).terminal_id;
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect((output.result as any).truncated).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("sandbox timeout kills a terminal with reason=timeout", async () => {
    const harness = await createIntegrationHarness({
      terminal: true,
      sandboxConfigOverrides: {
        timeoutMs: 200,
      },
    });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest("terminal/create", {
          args: ["sleep", "5"],
        });
        const terminalId = (created.result as any).terminal_id;
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });

        expect(
          harness.events.some(
            (entry) =>
              entry.type === "terminal.killed" && (entry.payload as any).reason === "timeout",
          ),
        ).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("executor.dispose during a running terminal emits terminal.killed with reason=dispatch_end", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        await server.sendRequest("terminal/create", {
          args: ["sleep", "10"],
        });

        await harness.executor.dispose();
        expect(
          harness.events.some(
            (entry) =>
              entry.type === "terminal.killed" && (entry.payload as any).reason === "dispatch_end",
          ),
        ).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with cwd outside the worktree fails before spawn with JSON-RPC code -32001", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/create", {
          args: ["echo", "x"],
          cwd: "/etc",
        });
        expect(response.error?.code).toBe(-32001);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });
});
