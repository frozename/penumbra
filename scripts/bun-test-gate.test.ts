import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const gatePath = join(repoRoot, "scripts/bun-test-gate.ts");

async function runGate(testPath: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bun", gatePath, testPath], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, output: stdout + stderr };
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

    expect(result.exitCode).toBe(0);
    expect(result.output.includes("Ran 1 test")).toBe(true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

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
