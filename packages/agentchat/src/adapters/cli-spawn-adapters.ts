import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import type { CapturePort } from "../worker/capture-port.js";
import type { ThoughtCapture } from "../worker/thought-capture.js";
import type { McpServer } from "./acp-types.js";

import {
  type CapacityError,
  spawnCliAdapter,
  spawnCliAdapterStream,
  type SpawnOpts,
} from "./cli-spawn.js";
import { prepareOpencodeMcpConfigDir } from "./opencode-mcp-config.js";
import { createStdioAcpAdapter, registerAdapter } from "./registry.js";
import { resolveAdapterApiKey } from "./secret.js";

export interface CliSpawnAdapterOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  pass_via?: "stdin" | "argv";
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
  capturePort?: CapturePort;
  emit_stdout_thoughts?: boolean;
}

export interface OpencodeCliAdapterOptions extends CliSpawnAdapterOptions {
  model?: string;
  mcpServers?: McpServer[];
}

export function cleanGeminiCliOutput(text: string): string {
  return text
    .replaceAll("MCP issues detected. Run /mcp list for status.", "")
    .split("\n")
    .filter(
      (line) =>
        !/^Export retry time \d+ms exceeds remaining timeout \d+ms, not retrying further\.$/.test(
          line,
        ),
    )
    .join("\n");
}

function emitCapacityError(capturePort: CapturePort | undefined, err: CapacityError): void {
  capturePort?.emit({
    kind: "capacity_error",
    provider: err.provider,
    model: err.model,
    raw: err.raw,
  });
}

type CliKind = "claude-cli" | "gemini-cli" | "agy-cli" | "codex-cli";

export function buildCliSpawnOpts(
  kind: CliKind,
  opts: CliSpawnAdapterOptions,
  defaultArgs: string[],
  command: string,
  thoughtCapture: ThoughtCapture | null,
  input: DispatchInput,
): SpawnOpts {
  void kind;
  return {
    command,
    args: opts.args ?? defaultArgs,
    prompt: input.prompt,
    signal: input.signal,
    cwd: opts.cwd,
    pass_via: opts.pass_via,
    env: opts.env,
    unset_env: opts.unset_env,
    strip_patterns: opts.strip_patterns,
    emit_stdout_thoughts: opts.emit_stdout_thoughts,
    permission_profile: input.permission_profile,
    sandbox_deny_roots: input.sandbox_deny_roots,
    thoughtCapture: thoughtCapture ?? undefined,
    onCapacityError: (err): void => {
      emitCapacityError(opts.capturePort, err);
    },
    eventContext: input.eventContext as SpawnOpts["eventContext"],
    onEvent: input.onEvent,
  };
}

export function makeCliSpawnAdapter(
  kind: CliKind,
  opts: CliSpawnAdapterOptions,
  defaultArgs: string[],
  transformText: (text: string) => string,
  thoughtCapture: ThoughtCapture | null,
): Adapter {
  const command = opts.command;
  if (!command) {
    throw new Error(`${kind}: command is required`);
  }
  const spawnOptsFor = (input: DispatchInput): SpawnOpts =>
    buildCliSpawnOpts(kind, opts, defaultArgs, command, thoughtCapture, input);
  return {
    kind,
    async dispatch(input: DispatchInput): Promise<DispatchOutput> {
      const { text } = await spawnCliAdapter(spawnOptsFor(input));
      return { text: transformText(text) };
    },
    async *dispatchStream(input: DispatchInput): AsyncGenerator<DispatchEvent> {
      for await (const event of spawnCliAdapterStream(spawnOptsFor(input))) {
        if (event.type === "done") {
          yield {
            ...event,
            result: {
              ...event.result,
              text: transformText(event.result.text),
            },
          };
          continue;
        }
        yield event;
      }
    },
  };
}

export async function buildOpencodeCliSpawnOpts(
  opts: OpencodeCliAdapterOptions,
  command: string,
  baseArgs: string[],
  thoughtCapture: ThoughtCapture | null,
  input: DispatchInput,
): Promise<SpawnOpts & { cleanup?: () => Promise<void> }> {
  let apiKey = "";
  try {
    apiKey = resolveAdapterApiKey({ apiKeyKeychain: "llamactl/opencode" });
  } catch {
    // Graceful degradation: let the CLI handle missing credentials.
  }

  const env: Record<string, string> = { ...opts.env, OPENCODE_API_KEY: apiKey };
  let cleanup: (() => Promise<void>) | undefined;
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    const prepared = await prepareOpencodeMcpConfigDir(opts.mcpServers);
    env.XDG_CONFIG_HOME = prepared.xdgConfigHome;
    cleanup = prepared.cleanup;
  }

  return {
    command,
    args: baseArgs,
    prompt: input.prompt,
    signal: input.signal,
    cwd: opts.cwd,
    pass_via: opts.pass_via ?? "argv",
    env,
    unset_env: opts.unset_env,
    strip_patterns: opts.strip_patterns,
    emit_stdout_thoughts: opts.emit_stdout_thoughts,
    permission_profile: input.permission_profile,
    sandbox_deny_roots: input.sandbox_deny_roots,
    thoughtCapture: thoughtCapture ?? undefined,
    onCapacityError: (err): void => {
      emitCapacityError(opts.capturePort, err);
    },
    eventContext: input.eventContext as SpawnOpts["eventContext"],
    onEvent: input.onEvent,
    cleanup,
  };
}

export function makeOpencodeCliAdapter(
  rawOptions: unknown,
  thoughtCapture: ThoughtCapture | null,
): Adapter {
  const opts = rawOptions as OpencodeCliAdapterOptions;
  if (!opts.model) {
    throw new Error("opencode-cli: model is required");
  }

  const model = opts.model.includes("/") ? opts.model : `opencode/${opts.model}`;
  const command = opts.command ?? "~/.opencode/bin/opencode".replace(/^~/, process.env.HOME ?? "");
  const baseArgs = opts.args ?? ["run", "--model", model];

  const spawnOptsFor = (
    input: DispatchInput,
  ): Promise<SpawnOpts & { cleanup?: () => Promise<void> }> =>
    buildOpencodeCliSpawnOpts(opts, command, baseArgs, thoughtCapture, input);

  return {
    kind: "opencode-cli",
    async dispatch(input: DispatchInput): Promise<DispatchOutput> {
      const spawnOpts = await spawnOptsFor(input);
      try {
        const { text, stderr } = await spawnCliAdapter(spawnOpts);
        if (!text.trim()) {
          const markers = [
            "ProviderModelNotFoundError",
            "Error: Model not found",
            "AuthenticationError",
            "Error: API key",
          ];
          const matched = markers.find((marker) => stderr.includes(marker));
          if (matched || stderr.trim()) {
            const msg = stderr.trim().slice(0, 500);
            throw new Error(`opencode-cli error: ${msg || "empty output"}`);
          }
        }
        return { text };
      } finally {
        await spawnOpts.cleanup?.();
      }
    },
    async *dispatchStream(input: DispatchInput): AsyncGenerator<DispatchEvent> {
      const spawnOpts = await spawnOptsFor(input);
      try {
        yield* spawnCliAdapterStream(spawnOpts);
      } finally {
        await spawnOpts.cleanup?.();
      }
    },
  };
}

export function registerThoughtAwareAdapters(thoughtCapture: ThoughtCapture | null): void {
  const registerCli = (
    kind: CliKind,
    defaultArgs: string[],
    transformText: (text: string) => string = (text) => text,
  ): void => {
    registerAdapter(
      kind,
      (rawOptions): Adapter =>
        makeCliSpawnAdapter(kind, rawOptions, defaultArgs, transformText, thoughtCapture),
    );
  };

  registerCli("claude-cli", ["code", "--no-tty"]);
  registerCli("gemini-cli", [], cleanGeminiCliOutput);
  registerCli("agy-cli", [], (text) => text);
  registerCli("codex-cli", []);

  registerAdapter(
    "opencode-cli",
    (rawOptions): Adapter => makeOpencodeCliAdapter(rawOptions, thoughtCapture),
  );

  // HIGH-1: route the worker's thought-aware stdio-acp registration through the
  // SAME factory as the registry builtin. The previous hand-rolled construction
  // here omitted the warm-pool opts + pool injection, so `warm_pool: true` was a
  // silent no-op in the real worker. The factory wires warm pool AND
  // thoughtCapture together; do not reintroduce a parallel opts map.
  registerAdapter("stdio-acp", (rawOptions) =>
    createStdioAcpAdapter(rawOptions, { thoughtCapture: thoughtCapture ?? undefined }),
  );
}
