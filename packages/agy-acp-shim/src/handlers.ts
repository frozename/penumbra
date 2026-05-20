import { createRpcServer } from './rpc.js';
import type {
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
} from './types.js';

export interface AgyHandle {
  exited: Promise<number | null>;
  kill(): void;
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
  handleInitialize(params: InitializeParams): Promise<InitializeResult>;
  handleSessionNew(params: SessionNewParams): Promise<SessionNewResult>;
}

export function makeHandlers(opts: HandlersOptions): Handlers {
  async function handleInitialize(_params: InitializeParams): Promise<InitializeResult> {
    return {
      protocolVersion: 1,
      authMethods: [],
    };
  }

  async function handleSessionNew(_params: SessionNewParams): Promise<SessionNewResult> {
    return { sessionId: crypto.randomUUID() };
  }

  return { handleInitialize, handleSessionNew };
}

export async function runShim(): Promise<void> {
  let server: ReturnType<typeof createRpcServer>;

  const { handleInitialize, handleSessionNew } = makeHandlers({
    spawnAgy: null as any,
    notify: (method, params) => server.notify(method, params),
  });

  server = createRpcServer({
    initialize: (params) => handleInitialize(params as InitializeParams),
    'session/new': (params) => handleSessionNew(params as SessionNewParams),
  });

  server.start();
}
