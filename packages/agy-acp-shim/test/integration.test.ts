import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const AGY_BINARY = process.env["AGY_BINARY"] ?? Bun.which("agy") ?? undefined;
const SHIM_ENTRY = new URL("../bin/agy-acp-shim.ts", import.meta.url).pathname;
const AGY_PRESENT = AGY_BINARY !== undefined && (await Bun.file(AGY_BINARY).exists());

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  result?: {
    sessionId?: string;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
    [key: string]: unknown;
  };
}

describe("rpc error handling", () => {
  it("returns a JSON-RPC error for session/cancel with an unknown session", async () => {
    const shim = spawn(process.execPath, [SHIM_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGY_BINARY },
    });

    const rl = createInterface({ input: shim.stdout, terminal: false });
    const readNext = (): Promise<JsonRpcResponse> =>
      new Promise((res, rej) => {
        const timeout = setTimeout(() => {
          rl.off("line", handler);
          rej(new Error("timed out waiting for shim response"));
        }, 1_000);
        const handler = (line: string): void => {
          clearTimeout(timeout);
          rl.off("line", handler);
          res(JSON.parse(line) as JsonRpcResponse);
        };
        rl.once("line", handler);
      });

    shim.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/cancel",
        params: { sessionId: "ghost" },
      }) + "\n",
    );

    const resp = await readNext();
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "not_a_session" },
    });

    shim.kill("SIGTERM");
  });
});

describe("integration (requires local agy binary)", () => {
  it.skipIf(!AGY_PRESENT)(
    "full ACP round-trip: initialize → session/new → session/prompt → assert pong",
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout, terminal: false });
      const readNext = (): Promise<JsonRpcResponse> =>
        new Promise((res) => {
          const handler = (line: string): void => {
            rl.off("line", handler);
            res(JSON.parse(line) as JsonRpcResponse);
          };
          rl.once("line", handler);
        });

      const send = (msg: object): void => {
        shim.stdin.write(JSON.stringify(msg) + "\n");
      };

      // 1. initialize
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "penumbra", version: "1.0.0" },
        },
      });
      const initResp = await readNext();
      expect(initResp.error).toBeUndefined();
      expect(initResp.result).toBeDefined();

      // 2. session/new
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
      const sessionResp = await readNext();
      const sessionId = sessionResp.result?.sessionId;
      expect(typeof sessionId).toBe("string");

      // 3. session/prompt — collect until done
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "respond with exactly the word: pong" }],
        },
      });

      let fullText = "";
      for (;;) {
        const msg = await readNext();
        if (msg.method === "done") break;
        if (msg.method === "session/update") {
          if (msg.params?.update?.sessionUpdate === "agent_message_chunk") {
            fullText += msg.params.update.content?.text ?? "";
          }
        }
      }
      expect(fullText.toLowerCase()).toContain("pong");

      shim.kill("SIGTERM");
    },
    120_000, // agy has ~3-5 s OAuth-resume + first-token latency
  );

  it.skipIf(!AGY_PRESENT)(
    "session/cancel kills the agy subprocess mid-prompt",
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout, terminal: false });
      const readNext = (): Promise<JsonRpcResponse> =>
        new Promise((res) => {
          const handler = (line: string): void => {
            rl.off("line", handler);
            res(JSON.parse(line) as JsonRpcResponse);
          };
          rl.once("line", handler);
        });
      const send = (msg: object): void => {
        shim.stdin.write(JSON.stringify(msg) + "\n");
      };

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "penumbra", version: "1.0.0" },
        },
      });
      await readNext();

      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
      const sessionResp = await readNext();
      const sessionId = sessionResp.result?.sessionId;

      // send a long prompt, immediately cancel
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [
            { type: "text", text: "write a 5000-word essay about the history of computing" },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 500));

      send({ jsonrpc: "2.0", id: 4, method: "session/cancel", params: { sessionId } });
      const cancelResp = await readNext();
      expect(cancelResp.error).toBeUndefined();

      shim.kill("SIGTERM");
    },
    60_000,
  );

  it.skipIf(!AGY_PRESENT)(
    "multi-paragraph reasoning prompts return multiline output",
    async () => {
      const shim = spawn(process.execPath, [SHIM_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGY_BINARY },
      });

      const rl = createInterface({ input: shim.stdout, terminal: false });
      const readNext = (): Promise<JsonRpcResponse> =>
        new Promise((res) => {
          const handler = (line: string): void => {
            rl.off("line", handler);
            res(JSON.parse(line) as JsonRpcResponse);
          };
          rl.once("line", handler);
        });
      const send = (msg: object): void => {
        shim.stdin.write(JSON.stringify(msg) + "\n");
      };

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "penumbra", version: "1.0.0" },
        },
      });
      await readNext();

      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
      const sessionResp = await readNext();
      const sessionId = sessionResp.result?.sessionId;

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "Explain in 3 short paragraphs why the order of operations matters in arithmetic. Be concise.",
            },
          ],
        },
      });

      let fullText = "";
      for (;;) {
        const msg = await readNext();
        if (msg.method === "done") break;
        if (msg.method === "session/update") {
          if (msg.params?.update?.sessionUpdate === "agent_message_chunk") {
            fullText += msg.params.update.content?.text ?? "";
          }
        }
      }

      expect(fullText.split("\n").filter((line) => line.trim().length > 0).length).toBeGreaterThan(
        1,
      );
      expect(fullText.toLowerCase()).toContain("order");

      shim.kill("SIGTERM");
    },
    120_000,
  );
});
