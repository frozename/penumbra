import type {
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
} from "./types.js";

import { spawnAgy as _spawnAgy } from "./agy-subprocess.js";
import { createRpcServer } from "./rpc.js";

const AGY_BINARY = process.env["AGY_BINARY"] ?? "agy";

export interface AgyHandle {
  exited: Promise<number | null>;
  kill: () => void;
}

export type SpawnAgyFn = (opts: {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
  signal?: AbortSignal;
}) => AgyHandle;

export interface HandlersOptions {
  spawnAgy: SpawnAgyFn;
  notify: (method: string, params?: unknown) => void;
}

export interface Handlers {
  handleInitialize: (params: InitializeParams) => Promise<InitializeResult>;
  handleSessionNew: (params: SessionNewParams) => Promise<SessionNewResult>;
  handleSessionPrompt: (params: SessionPromptParams) => Promise<SessionPromptResult>;
  handleSessionCancel: (params: { sessionId: string }) => Promise<Record<string, never>>;
}

export function makeHandlers(opts: HandlersOptions): Handlers {
  const inFlight = new Map<string, AgyHandle>();
  const cancelled = new Set<string>();

  function handleInitialize(_params: InitializeParams): Promise<InitializeResult> {
    return Promise.resolve({
      protocolVersion: 1,
      authMethods: [],
    });
  }

  function handleSessionNew(_params: SessionNewParams): Promise<SessionNewResult> {
    return Promise.resolve({ sessionId: crypto.randomUUID() });
  }

  async function handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const promptText = params.prompt.map((p) => p.text).join("\n");

    // agy >= 1.4 greedily consumes the next argv token as the --print value,
    // so a bare "--print" followed by a flag makes the flag the prompt. The
    // prompt must stay attached to the flag.
    const argv = [
      "--dangerously-skip-permissions",
      "--sandbox",
      "--print-timeout",
      "10m",
      "--conversation",
      params.sessionId,
      `--print=${promptText}`,
    ];

    const handle = opts.spawnAgy({
      binary: AGY_BINARY,
      args: argv,
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

  function handleSessionCancel(params: { sessionId: string }): Promise<Record<string, never>> {
    const handle = inFlight.get(params.sessionId);
    if (!handle) {
      const err = new Error("not_a_session");
      (err as Error & { code?: number }).code = -32002;
      throw err;
    }

    cancelled.add(params.sessionId);
    inFlight.delete(params.sessionId);
    handle.kill();
    return Promise.resolve({});
  }

  return { handleInitialize, handleSessionNew, handleSessionPrompt, handleSessionCancel };
}

export function runShim(): void {
  const serverRef: { current: ReturnType<typeof createRpcServer> | undefined } = {
    current: undefined,
  };

  const handlers = makeHandlers({
    spawnAgy: _spawnAgy,
    notify: (method, params) => {
      serverRef.current?.notify(method, params);
    },
  });

  const server = createRpcServer({
    initialize: (params) => handlers.handleInitialize(params as InitializeParams),
    "session/new": (params) => handlers.handleSessionNew(params as SessionNewParams),
    "session/prompt": (params) => handlers.handleSessionPrompt(params as SessionPromptParams),
    "session/cancel": (params) => handlers.handleSessionCancel(params as { sessionId: string }),
  });
  serverRef.current = server;

  server.start();
}
