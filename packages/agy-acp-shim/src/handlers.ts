import { createRpcServer } from './rpc.js';
import type {
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
} from './types.js';

const AGY_BINARY = process.env['AGY_BINARY'] ?? 'agy';

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
  handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult>;
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

  async function handleSessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const promptText = params.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');

    const argv = [
      '--print', promptText,
      '--dangerously-skip-permissions',
      '--sandbox',
      '--print-timeout', '10m',
      '--conversation', params.sessionId,
    ];

    const handle = opts.spawnAgy({
      binary: AGY_BINARY,
      args: argv,
      onLine: (line) => {
        opts.notify('session/update', {
          event: {
            type: 'message.part.delta',
            messageID: params.sessionId,
            partIndex: 0,
            delta: line + '\n',
          },
        });
      },
    });

    await handle.exited;
    opts.notify('done', {});
    return {};
  }

  return { handleInitialize, handleSessionNew, handleSessionPrompt };
}

export async function runShim(): Promise<void> {
  let server: ReturnType<typeof createRpcServer>;

  const { handleInitialize, handleSessionNew, handleSessionPrompt } = makeHandlers({
    spawnAgy: null as any,
    notify: (method, params) => server.notify(method, params),
  });

  server = createRpcServer({
    initialize: (params) => handleInitialize(params as InitializeParams),
    'session/new': (params) => handleSessionNew(params as SessionNewParams),
    'session/prompt': (params) => handleSessionPrompt(params as SessionPromptParams),
  });

  server.start();
}
