import { afterEach, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAcpServer, type AcpServerSpawner } from "../../src/adapters/acp-server.js";
import { RUN_AGENTCHAT_SERVICE_TESTS } from "../helpers/service-gates.js";

const cleanupPids = new Set<number>();
const cleanupDirs = new Set<string>();

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  cleanupPids.clear();

  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} is still alive`);
}

async function readProcessPids(stdout: NodeJS.ReadableStream): Promise<{
  childPid: number;
  grandchildPid: number;
}> {
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += chunk.toString();
    const childMatch = buffer.match(/^child=(\d+)$/m);
    const grandchildMatch = buffer.match(/^grandchild=(\d+)$/m);
    if (childMatch && grandchildMatch) {
      return {
        childPid: Number(childMatch[1]),
        grandchildPid: Number(grandchildMatch[1]),
      };
    }
  }
  throw new Error(`fake opencode exited before printing pids: ${buffer}`);
}

function writeFakeOpencode(dir: string): string {
  const grandchildPath = join(dir, "grandchild.mjs");
  const opencodePath = join(dir, "fake-opencode.mjs");

  writeFileSync(
    grandchildPath,
    `
process.stdout.write("grandchild-ready\\n");
setInterval(() => {}, 1_000);
`,
  );

  writeFileSync(
    opencodePath,
    `
import { spawn } from "node:child_process";
import * as net from "node:net";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const grandchild = spawn(process.execPath, ["${grandchildPath}"], {
  stdio: ["ignore", "pipe", "inherit"],
});
grandchild.stdout.setEncoding("utf8");
grandchild.stdout.once("data", () => {
  process.stdout.write(\`child=\${process.pid}\\n\`);
  process.stdout.write(\`grandchild=\${grandchild.pid}\\n\`);
});

const server = net.createServer((socket) => socket.destroy());
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1_000);
`,
  );

  return opencodePath;
}

describe.skipIf(!RUN_AGENTCHAT_SERVICE_TESTS)("startAcpServer process group cleanup", () => {
  test.skipIf(process.platform === "win32")(
    "kill reaps the opencode ACP process and its MCP grandchild",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "penumbra-acp-group-"));
      cleanupDirs.add(dir);
      const fakeOpencode = writeFakeOpencode(dir);
      let pidsPromise: Promise<{ childPid: number; grandchildPid: number }> | null = null;

      const spawn: AcpServerSpawner = (_command, args, options) => {
        const child = nodeSpawn(process.execPath, [fakeOpencode, ...args], options);
        pidsPromise = readProcessPids(child.stdout);
        return child;
      };

      const handle = await startAcpServer({
        cwd: dir,
        spawn,
        bootTimeoutMs: 2_000,
      });
      cleanupPids.add(handle.pid);
      const pids = await pidsPromise!;
      cleanupPids.add(pids.childPid);
      cleanupPids.add(pids.grandchildPid);

      expect(pids.childPid).toBe(handle.pid);
      expect(isAlive(pids.childPid)).toBe(true);
      expect(isAlive(pids.grandchildPid)).toBe(true);

      await handle.kill();
      await waitUntilDead(pids.childPid);
      await waitUntilDead(pids.grandchildPid);

      cleanupPids.delete(pids.childPid);
      cleanupPids.delete(pids.grandchildPid);
    },
  );
});
