import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { makeSandbox } from "./helpers/sandbox.js";
import { captureOutput, PENUMBRA_MCP_BIN, spawnBun } from "./helpers/spawn-bin.js";

const HARNESS = join(new URL(".", import.meta.url).pathname, "..", "bin", "penumbra-harness.ts");

function runHarness(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return captureOutput(spawnBun([HARNESS, ...args], {}));
}

test("--help exits 0 and prints the usage line", async () => {
  const { exitCode, stdout } = await runHarness("--help");
  expect(exitCode).toBe(0);
  expect(stdout.startsWith("usage: penumbra-harness [options]")).toBe(true);
});

test("-h exits 0 and prints the same usage line", async () => {
  const { exitCode, stdout } = await runHarness("-h");
  expect(exitCode).toBe(0);
  expect(stdout.startsWith("usage: penumbra-harness [options]")).toBe(true);
});

test("unknown flag exits 1 with unknown argument error", async () => {
  const { exitCode, stderr } = await runHarness("--bogus");
  expect(exitCode).toBe(1);
  expect(stderr).toContain("unknown argument: --bogus");
});

test("unknown flag is rejected even when --help precedes it", async () => {
  const { exitCode, stdout, stderr } = await runHarness("--help", "--bogus");
  expect(exitCode).toBe(1);
  expect(stderr).toContain("unknown argument: --bogus");
  expect(stdout).not.toContain("usage:");
});

test("unsupported --llm-driver value exits 1", async () => {
  const { exitCode, stderr } = await runHarness("--llm-driver", "ollama");
  expect(exitCode).toBe(1);
  expect(stderr).toContain("unsupported --llm-driver: ollama");
});

test("--llm-driver with no value exits 1 with undefined", async () => {
  const { exitCode, stderr } = await runHarness("--llm-driver");
  expect(exitCode).toBe(1);
  expect(stderr).toContain("unsupported --llm-driver: undefined");
});

test("--mcp-config-only without --sandbox exits 1", async () => {
  const { exitCode, stderr } = await runHarness("--mcp-config-only");
  expect(exitCode).toBe(1);
  expect(stderr).toContain("--mcp-config-only requires --sandbox <path>");
});

test("--mcp-config-only with missing port file exits 1", async () => {
  const sb = makeSandbox();
  try {
    const { exitCode, stderr } = await runHarness("--mcp-config-only", "--sandbox", sb.dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`No daemon running at sandbox ${sb.dir} (port file missing).`);
  } finally {
    sb.cleanup();
  }
});

test("port file with non-numeric content exits 1", async () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb.dir, "port"), "abc");
    const { exitCode, stderr } = await runHarness("--mcp-config-only", "--sandbox", sb.dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("is not a valid port: abc");
  } finally {
    sb.cleanup();
  }
});

test("port file with non-integer value exits 1", async () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb.dir, "port"), "4242.5");
    const { exitCode, stderr } = await runHarness("--mcp-config-only", "--sandbox", sb.dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("is not a valid port: 4242.5");
  } finally {
    sb.cleanup();
  }
});

test("valid port file prints MCP config JSON with trimmed whitespace", async () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb.dir, "port"), "  4242\n");
    const { exitCode, stdout } = await runHarness("--mcp-config-only", "--sandbox", sb.dir);
    expect(exitCode).toBe(0);

    const lines = stdout.split("\n");
    const banner = "=== Claude Code MCP config (paste into your .mcp.json) ===";
    const start = lines.indexOf(banner);
    expect(start).toBeGreaterThan(-1);
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i] === "}") {
        end = i;
        break;
      }
    }
    expect(end).toBeGreaterThan(start);
    const parsed = JSON.parse(lines.slice(start + 1, end + 1).join("\n")) as {
      mcpServers: {
        penumbra: {
          type: string;
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };
    const penumbra = parsed.mcpServers.penumbra;
    expect({
      mcpServers: {
        penumbra: {
          type: penumbra.type,
          command: penumbra.command,
          args: penumbra.args.map((a) => resolve(a)),
          env: { PENUMBRA_STORAGE_ROOT: resolve(penumbra.env["PENUMBRA_STORAGE_ROOT"] ?? "") },
        },
      },
    }).toEqual({
      mcpServers: {
        penumbra: {
          type: "stdio",
          command: "bun",
          args: [resolve(PENUMBRA_MCP_BIN)],
          env: { PENUMBRA_STORAGE_ROOT: resolve(sb.dir) },
        },
      },
    });
  } finally {
    sb.cleanup();
  }
});

test("valid port file prints daemon listening line", async () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb.dir, "port"), "4242");
    const { exitCode, stdout } = await runHarness("--mcp-config-only", "--sandbox", sb.dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      `(daemon listening on http://127.0.0.1:4242; storage root: ${sb.dir})`,
    );
  } finally {
    sb.cleanup();
  }
});

test("mcp-config-only is dispatched before the llamactl driver", async () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb.dir, "port"), "4242");
    const { exitCode, stdout } = await runHarness(
      "--llm-driver",
      "llamactl",
      "--mcp-config-only",
      "--sandbox",
      sb.dir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("=== Claude Code MCP config");
  } finally {
    sb.cleanup();
  }
});
