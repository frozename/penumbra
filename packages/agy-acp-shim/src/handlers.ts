import { createRpcServer } from "./rpc.js";
import { spawnAgy as _spawnAgy } from "./agy-subprocess.js";
import type {
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
} from "./types.js";

const AGY_BINARY = process.env["AGY_BINARY"] ?? "agy";

export interface AgyHandle {
  exited: Promise<number | null>;
  kill(): void;
}

export type SpawnAgyFn = (opts: {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
  prompt?: string;
  signal?: AbortSignal;
}) => AgyHandle;

export interface HandlersOptions {
  spawnAgy: SpawnAgyFn;
  notify: (method: string, params?: unknown) => void;
}

export interface Handlers {
  handleInitialize(params: InitializeParams): Promise<InitializeResult>;
  handleSessionNew(params: SessionNewParams): Promise<SessionNewResult>;
  handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult>;
  handleSessionCancel(params: { sessionId: string }): Promise<{}>;
}

export function makeHandlers(opts: HandlersOptions): Handlers {
  const inFlight = new Map<string, AgyHandle>();
  const cancelled = new Set<string>();

  async function handleInitialize(_params: InitializeParams): Promise<InitializeResult> {
    return {
      protocolVersion: 1,
      authMethods: [],
    };
  }

  async function handleSessionNew(_params: SessionNewParams): Promise<SessionNewResult> {
    return { sessionId: crypto.randomUUID() };
  }

  async function handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const promptText = params.prompt
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const argv = [
      "--print",
      "--dangerously-skip-permissions",
      "--sandbox",
      "--print-timeout",
      "10m",
      "--conversation",
      params.sessionId,
    ];

    const handle = opts.spawnAgy({
      binary: AGY_BINARY,
      args: argv,
      prompt: promptText,
      onLine: (line) => {
        opts.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: line + "\n",
            },
          },
        });
      },
    });

    inFlight.set(params.sessionId, handle);
    cancelled.delete(params.sessionId);

    let code: number | null = null;
    try {
      code = await handle.exited;
      opts.notify("done", {});
    } finally {
      if (inFlight.get(params.sessionId) === handle) {
        inFlight.delete(params.sessionId);
      }
    }

    if (cancelled.delete(params.sessionId)) {
      return { stopReason: "cancelled" };
    }
    if (code !== 0) {
      return { stopReason: "failed" };
    }
    return { stopReason: "end_turn" };
  }

  async function handleSessionCancel(params: { sessionId: string }): Promise<{}> {
    const handle = inFlight.get(params.sessionId);
    if (!handle) {
      const err = new Error("not_a_session");
      (err as Error & { code?: number }).code = -32002;
      throw err;
    }

    cancelled.add(params.sessionId);
    inFlight.delete(params.sessionId);
    handle.kill();
    return {};
  }

  return { handleInitialize, handleSessionNew, handleSessionPrompt, handleSessionCancel };
}

export async function runShim(): Promise<void> {
  let server: ReturnType<typeof createRpcServer>;

  const { handleInitialize, handleSessionNew, handleSessionPrompt, handleSessionCancel } =
    makeHandlers({
      spawnAgy: _spawnAgy,
      notify: (method, params) => server.notify(method, params),
    });

  server = createRpcServer({
    initialize: (params) => handleInitialize(params as InitializeParams),
    "session/new": (params) => handleSessionNew(params as SessionNewParams),
    "session/prompt": (params) => handleSessionPrompt(params as SessionPromptParams),
    "session/cancel": (params) => handleSessionCancel(params as { sessionId: string }),
  });

  server.start();
}
