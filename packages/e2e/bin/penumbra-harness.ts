#!/usr/bin/env bun

// Bootstrap the homebrew-supplied sqlite for sqlite-vec on macOS.
// Must run before any `new Database(...)` call. Idempotent.
import { Database } from "bun:sqlite";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded or not available */
}

import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInit } from "../../cli/src/commands/init.js";
import { runStart } from "../../cli/src/commands/start.js";
import { runStop } from "../../cli/src/commands/stop.js";

interface Args {
  sandbox?: string;
  persist: boolean;
  mcpConfigOnly: boolean;
  pretty: boolean;
  noTail: boolean;
  help: boolean;
  llmDriver?: "llamactl";
  manifest?: string;
  siriusBaseUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    persist: false,
    mcpConfigOnly: false,
    pretty: process.stdout.isTTY ?? false,
    noTail: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--sandbox":
        out.sandbox = argv[++i];
        break;
      case "--persist":
        out.persist = true;
        break;
      case "--mcp-config-only":
        out.mcpConfigOnly = true;
        break;
      case "--pretty":
        out.pretty = true;
        break;
      case "--no-tail":
        out.noTail = true;
        break;
      case "--llm-driver": {
        const v = argv[++i];
        if (v !== "llamactl") throw new Error(`unsupported --llm-driver: ${v}`);
        out.llmDriver = v;
        break;
      }
      case "--manifest":
        out.manifest = argv[++i];
        break;
      case "--sirius-base-url":
        out.siriusBaseUrl = argv[++i];
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`usage: penumbra-harness [options]

  --sandbox <path>          Reuse an existing storage root.
  --persist                 Keep the sandbox dir on exit.
  --mcp-config-only         Print the MCP config snippet for an existing
                            sandbox (--sandbox required), then exit.
  --llm-driver llamactl     Orchestrate an llamactl composite that brings
                            up a sirius-compatible embedder, then start
                            Penumbra wired to it.
  --manifest <path>         (with --llm-driver llamactl) Override the
                            llamactl composite manifest. Default:
                            packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml.
  --sirius-base-url <url>   (with --llm-driver llamactl) Override sirius URL.
  --pretty                  Pretty-print JSON log lines.
  --no-tail                 Don't tail logs after starting.
  -h, --help                Print this help.`);
}

function findRepoRoot(): string {
  // bin/penumbra-harness.ts → ../../.. = repo root
  const here = new URL(".", import.meta.url).pathname;
  return resolve(here, "..", "..", "..");
}

function mcpBinPath(): string {
  return join(findRepoRoot(), "packages/mcp/bin/penumbra-mcp.ts");
}

function printMcpConfig(sandbox: string, port: number): void {
  const config = {
    mcpServers: {
      penumbra: {
        type: "stdio",
        command: "bun",
        args: [mcpBinPath()],
        env: {
          PENUMBRA_STORAGE_ROOT: sandbox,
        },
      },
    },
  };
  console.log("");
  console.log("=== Claude Code MCP config (paste into your .mcp.json) ===");
  console.log(JSON.stringify(config, null, 2));
  console.log("");
  console.log(`(daemon listening on http://127.0.0.1:${port}; storage root: ${sandbox})`);
  console.log("");
}

async function runMcpConfigOnly(args: Args): Promise<number> {
  if (!args.sandbox) {
    console.error("--mcp-config-only requires --sandbox <path>");
    return 1;
  }
  let portRaw: string;
  try {
    portRaw = readFileSync(join(args.sandbox, "port"), "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`No daemon running at sandbox ${args.sandbox} (port file missing).`);
      return 1;
    }
    throw err;
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port)) {
    console.error(`port file ${join(args.sandbox, "port")} is not a valid port: ${portRaw}`);
    return 1;
  }
  printMcpConfig(args.sandbox, port);
  return 0;
}

async function runDefault(args: Args): Promise<number> {
  const userProvidedSandbox = !!args.sandbox;
  const sandbox = args.sandbox ?? mkdtempSync(join(tmpdir(), "penumbra-harness-"));
  let stopping = false;
  let cleanedUp = false;

  await runInit({ storageRoot: sandbox });
  const handle = await runStart({ storageRoot: sandbox });
  printMcpConfig(sandbox, handle.port);

  if (!args.noTail) {
    console.log("Tailing daemon log. Press Ctrl-C to stop.");
  }

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await runStop({ storageRoot: sandbox, handle });
    } catch (err) {
      console.error(`runStop error: ${(err as Error).message}`);
    }
    if (!args.persist && !userProvidedSandbox) {
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  const onSignal = async (sig: string): Promise<void> => {
    if (stopping) {
      console.error(`\n${sig} received during shutdown; forcing exit. Resources may leak.`);
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${sig} received; shutting down...`);
    await cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void onSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void onSignal("SIGTERM");
  });

  // Block forever; signals drive exit.
  await new Promise<never>(() => {});
  return 0;
}

async function runLlamactl(args: Args): Promise<number> {
  if (!Bun.which("llamactl")) {
    console.error("llamactl not found on PATH");
    return 1;
  }
  const repoRoot = findRepoRoot();
  const defaultManifest = join(
    repoRoot,
    "packages/e2e/test/fixtures/llamactl-sirius-embedder.yaml",
  );
  const manifest = args.manifest ?? defaultManifest;

  console.log(`applying llamactl composite: ${manifest}`);
  const apply = Bun.spawn({
    cmd: ["llamactl", "composite", "apply", "-f", manifest],
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await apply.exited) !== 0) {
    console.error("llamactl composite apply failed");
    return 2;
  }

  const baseUrl =
    args.siriusBaseUrl ?? process.env.PENUMBRA_SIRIUS_BASE_URL ?? "http://127.0.0.1:18080";
  const token = process.env.PENUMBRA_SIRIUS_TOKEN ?? "test";
  const model = process.env.PENUMBRA_SIRIUS_MODEL ?? "text-embedding-3-small";
  const dim = process.env.PENUMBRA_SIRIUS_DIM ?? "1536";

  console.log(`waiting for sirius at ${baseUrl}/healthz ...`);
  const healthDeadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    console.error("sirius did not become healthy in 30s; cleaning up...");
    const del = Bun.spawn({
      cmd: ["llamactl", "composite", "delete", "-f", manifest],
      stdout: "inherit",
      stderr: "inherit",
    });
    await del.exited;
    return 3;
  }

  // Set sirius env vars so runStart picks them up.
  process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS = "true";
  process.env.PENUMBRA_SIRIUS_BASE_URL = baseUrl;
  process.env.PENUMBRA_SIRIUS_TOKEN = token;
  process.env.PENUMBRA_SIRIUS_MODEL = model;
  process.env.PENUMBRA_SIRIUS_DIM = dim;

  const userProvidedSandbox = !!args.sandbox;
  const sandbox = args.sandbox ?? mkdtempSync(join(tmpdir(), "penumbra-harness-llamactl-"));
  let stopping = false;
  let cleanedUp = false;

  await runInit({ storageRoot: sandbox });
  const handle = await runStart({ storageRoot: sandbox });
  printMcpConfig(sandbox, handle.port);
  console.log(`sirius backend: ${baseUrl} (model ${model}, dim ${dim})`);
  if (!args.noTail) console.log("Press Ctrl-C to tear down.");

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await runStop({ storageRoot: sandbox, handle });
    } catch (err) {
      console.error(`runStop error: ${(err as Error).message}`);
    }
    const del = Bun.spawn({
      cmd: ["llamactl", "composite", "delete", "-f", manifest],
      stdout: "inherit",
      stderr: "inherit",
    });
    await del.exited;
    if (!args.persist && !userProvidedSandbox) {
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  const onSignal = async (sig: string): Promise<void> => {
    if (stopping) {
      console.error(`\n${sig} received during shutdown; forcing exit. Resources may leak.`);
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${sig} received; tearing down...`);
    await cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void onSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void onSignal("SIGTERM");
  });

  await new Promise<never>(() => {});
  return 0;
}

const args = parseArgs(process.argv);
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.mcpConfigOnly) {
  process.exit(await runMcpConfigOnly(args));
}
if (args.llmDriver === "llamactl") {
  process.exit(await runLlamactl(args));
}
process.exit(await runDefault(args));
