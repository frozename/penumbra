import { StdioAcpClient } from "@penumbra/agentchat";
import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import type { DiscoveredModel } from "./discovery-types.js";

export type AcpSessionSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RunAcpHandshakeOpts {
  command: string;
  args: string[];
  spawn?: AcpSessionSpawner;
  timeoutMs: number;
  unsetEnv?: string[];
}

export interface DiscoverAcpSessionModelsOpts extends RunAcpHandshakeOpts {
  providerId: string;
}

interface ChildExitStatus {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scrubbedInheritedEnv(unsetEnv: readonly string[] = []): NodeJS.ProcessEnv {
  const unsetKeys = new Set(unsetEnv);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "CLAUDECODE" &&
        !key.startsWith("CLAUDE_") &&
        !unsetKeys.has(key),
    ),
  );
}

function requestWithTimeout(
  client: StdioAcpClient,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    client.request(method, params),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`ACP session discovery ${method} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<ChildExitStatus> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child.exitCode, signalCode: child.signalCode });
  }
  return new Promise((resolve) => {
    const onExit = (exitCode: number | null, signalCode: NodeJS.Signals | null): void => {
      child.off("error", onError);
      resolve({ exitCode, signalCode });
    };
    const onError = (): void => {
      child.off("exit", onExit);
      resolve({ exitCode: child.exitCode, signalCode: child.signalCode });
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function runAcpHandshake(opts: RunAcpHandshakeOpts): Promise<unknown> {
  const spawn: AcpSessionSpawner =
    opts.spawn ??
    ((command, args, options): ChildProcessWithoutNullStreams => nodeSpawn(command, args, options));
  const child = spawn(opts.command, opts.args, {
    cwd: process.cwd(),
    env: scrubbedInheritedEnv(opts.unsetEnv),
  });
  const exited = waitForChildExit(child);

  try {
    child.stderr.resume();
    // eslint-disable-next-line no-console -- discovery lifecycle must be visible at info level.
    console.info("acp-session discovery spawned", { pid: child.pid ?? null });
    // Gemini's ACP mode was retired on 2026-06-19 after upstream misclassified ENOENT
    // during file-write tool calls. This capability-only handshake issues no tool call;
    // successful discovery does not mean Gemini ACP editing is healthy again.
    const client = new StdioAcpClient({ stdin: child.stdin, stdout: child.stdout });
    await requestWithTimeout(
      client,
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "penumbra-provider-discovery", version: "1.0.0" },
      },
      opts.timeoutMs,
    );
    return await requestWithTimeout(
      client,
      "session/new",
      { cwd: process.cwd(), mcpServers: [] },
      opts.timeoutMs,
    );
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited between the final response and teardown.
    }
    const status = await exited;
    // eslint-disable-next-line no-console -- discovery lifecycle must be visible at info level.
    console.info("acp-session discovery exited", {
      pid: child.pid ?? null,
      exitCode: status.exitCode,
      signalCode: status.signalCode,
    });
  }
}

export function parseAcpSessionModels(result: unknown, providerId: string): DiscoveredModel[] {
  if (!isRecord(result) || !isRecord(result.models)) return [];
  const availableModels = result.models.availableModels;
  if (!Array.isArray(availableModels)) return [];

  // Session-advertised availableModels is capability truth. It is catalog truth when
  // no separate model carrier exists (Claude/Gemini), but not when a binding pins its
  // model elsewhere, such as the Alibaba/Codex carrier case.
  return availableModels.flatMap((entry): DiscoveredModel[] => {
    if (!isRecord(entry) || typeof entry.modelId !== "string" || entry.modelId.length === 0) {
      return [];
    }
    const displayName =
      typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.modelId;
    return [
      {
        sourceProviderId: providerId,
        modelId: entry.modelId,
        displayName,
        ...(typeof entry.description === "string"
          ? { metadata: { description: entry.description } }
          : {}),
      },
    ];
  });
}

export async function discoverAcpSessionModels(
  opts: DiscoverAcpSessionModelsOpts,
): Promise<DiscoveredModel[] | { outcome: "skipped"; reason: string }> {
  const result = await runAcpHandshake(opts);
  const models = parseAcpSessionModels(result, opts.providerId);
  return models.length > 0
    ? models
    : {
        outcome: "skipped",
        reason: "ACP session handshake did not advertise any available models",
      };
}
