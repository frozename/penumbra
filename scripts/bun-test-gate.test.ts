import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const gatePath = join(repoRoot, "scripts/bun-test-gate.ts");

async function runGate(
  testPath: string,
  whileRunning?: () => Promise<void>,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bun", gatePath, testPath], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
    whileRunning?.(),
  ]);

  return { exitCode, output: stdout + stderr };
}

async function poll<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

interface ShardPids {
  shard: number;
  gate: number;
}

function readShardPids(path: string): ShardPids | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ShardPids;
  } catch {
    return undefined;
  }
}

// A zombie has already called exit_group, so the reporter's last write is done.
function hasExited(pid: number): true | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return /^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2)) ? true : undefined;
  } catch {
    return true;
  }
}

test("bun-test-gate lets a passing test shard emit more than the spawnSync default pipe buffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-gate-large-output-"));
  try {
    const testPath = join(dir, "big-output.test.ts");
    writeFileSync(
      testPath,
      `
import { expect, test } from "bun:test";

const chunk = "x".repeat(64 * 1024);

function writeChunk(stream: NodeJS.WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("passes after large stdout and stderr writes", async () => {
  for (let index = 0; index < 33; index += 1) {
    await Promise.all([
      writeChunk(process.stdout, \`stdout-\${index} \${chunk}\\n\`),
      writeChunk(process.stderr, \`stderr-\${index} \${chunk}\\n\`),
    ]);
  }
  expect(1).toBe(1);
});
`,
    );

    const result = await runGate(testPath);

    // The shard's own output is captured, so a failure is otherwise opaque in CI.
    // Uppercased because this test itself runs under the gate: the summary and
    // panic patterns in bun-test-output.ts are case-sensitive, so the echoed
    // inner summary cannot be read as the outer shard's own result.
    if (result.exitCode !== 0) console.error(result.output.slice(-4000).toUpperCase());
    expect(result.exitCode).toBe(0);
    expect(result.output.includes("Ran 1 test")).toBe(true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// Bun makes the shard's fd 2 O_NONBLOCK once its JS stderr writer exists, and
// its reporter drops the summary if that write hits EAGAIN. Freezing the gate
// guarantees nothing drains the shard's stderr between the fill and the summary.
test.skipIf(process.platform !== "linux")(
  "bun-test-gate keeps the summary of a shard whose stderr is full as it finishes",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-test-gate-full-stderr-"));
    const pidsPath = join(dir, "pids.json");
    let frozenGatePid: number | undefined;
    try {
      const testPath = join(dir, "full-stderr.test.ts");
      writeFileSync(
        testPath,
        `
import { expect, test } from "bun:test";
import { writeFileSync, writeSync } from "node:fs";

test("finishes with stderr full while the gate is frozen", () => {
  writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ shard: process.pid, gate: process.ppid }));
  process.kill(process.ppid, "SIGSTOP");
  process.stderr.write("");
  const chunk = Buffer.alloc(64 * 1024, "y");
  let written = 0;
  try {
    while (written < 4 * 1024 * 1024) written += writeSync(2, chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
  }
  expect(written).toBeGreaterThan(0);
});
`,
      );

      const result = await runGate(testPath, async () => {
        const pids = await poll(() => readShardPids(pidsPath), "the shard's pids");
        frozenGatePid = pids.gate;
        await poll(() => hasExited(pids.shard), "the shard to exit");
        process.kill(pids.gate, "SIGCONT");
      });

      if (result.exitCode !== 0) console.error(result.output.slice(-4000).toUpperCase());
      expect(result.exitCode).toBe(0);
      expect(result.output.includes("Ran 1 test")).toBe(true);
    } finally {
      if (frozenGatePid !== undefined) {
        try {
          process.kill(frozenGatePid, "SIGCONT");
        } catch {
          // already exited
        }
      }
      rmSync(dir, { force: true, recursive: true });
    }
  },
  30_000,
);

test("bun-test-gate relays split utf8 stdout bytes without replacement characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-gate-utf8-output-"));
  try {
    const testPath = join(dir, "utf8-output.test.ts");
    writeFileSync(
      testPath,
      `
import { expect, test } from "bun:test";

const char = "—";
const chunk = char.repeat(100000);
const writes = 7;

function writeChunk(stream: NodeJS.WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("passes after large multibyte stdout writes", async () => {
  for (let index = 0; index < writes; index += 1) {
    await writeChunk(process.stdout, chunk);
  }
  expect(1).toBe(1);
});
`,
    );

    const result = await runGate(testPath);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("�");
    expect(result.output.match(/—/gu)?.length ?? 0).toBe(700000);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("bun-test-gate still reports an ordinary failing test shard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-gate-failure-"));
  try {
    const testPath = join(dir, "failure.test.ts");
    writeFileSync(
      testPath,
      `
import { expect, test } from "bun:test";

test("fails", () => {
  expect(1).toBe(2);
});
`,
    );

    const result = await runGate(testPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("bun-test-gate: failing");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("bun-test-gate fails a shard that exits 0 without reaching a summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-gate-no-summary-"));
  try {
    const testPath = join(dir, "no-summary.test.ts");
    writeFileSync(
      testPath,
      `
import { test } from "bun:test";

console.log("early module exit");
process.exit(0);

test("never runs", () => {});
`,
    );

    const result = await runGate(testPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("bun-test-gate: failing");
    expect(result.output).toContain("reachedSummary=false");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
