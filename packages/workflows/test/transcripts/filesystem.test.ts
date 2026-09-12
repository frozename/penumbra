import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexTranscript } from "@src/transcripts/codex.js";
import type { TranscriptReadResult } from "@src/transcripts/types.js";

const FORMAT = "penumbra-codex-rollout-fixture-v1";
const READER_MODULE_URL = new URL("../../src/transcripts/codex.ts", import.meta.url).href;

function sessionMeta(cwd: string): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: {
      id: "wanted",
      session_id: "wanted",
      cwd,
      originator: "codex_exec",
      cli_version: "0.153.4",
      source: "exec",
    },
  };
}

function message(text: string): Record<string, unknown> {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  };
}

function jsonl(records: Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function makeRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "codex-transcript-filesystem-")));
}

async function read(path: string, expectedCwd: string): Promise<TranscriptReadResult> {
  return await readCodexTranscript({
    path,
    expectedSessionId: "wanted",
    expectedCwd,
    format: FORMAT,
  });
}

async function runReaderInBoundedChild(
  path: string,
  expectedCwd: string,
): Promise<{
  exitCode: number | null;
  stillAliveAfterOneSecond: boolean;
  stdout: string;
  stderr: string;
}> {
  const source = [
    `import { readCodexTranscript } from ${JSON.stringify(READER_MODULE_URL)};`,
    `const result = await readCodexTranscript(${JSON.stringify({
      path,
      expectedSessionId: "wanted",
      expectedCwd,
      format: FORMAT,
    })});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, stillAliveAfterOneSecond: false })),
    new Promise<{ exitCode: null; stillAliveAfterOneSecond: true }>((resolveTimeout) => {
      setTimeout(() => {
        resolveTimeout({ exitCode: null, stillAliveAfterOneSecond: true });
      }, 1_000);
    }),
  ]);
  let exitCode = outcome.exitCode;
  if (outcome.stillAliveAfterOneSecond) {
    child.kill("SIGTERM");
    exitCode = await child.exited;
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    exitCode,
    stillAliveAfterOneSecond: outcome.stillAliveAfterOneSecond,
    stdout,
    stderr,
  };
}

test("returns unavailable promptly for an owned named pipe", async () => {
  const root = await makeRoot();
  const path = join(root, "transcript.fifo");
  try {
    const mkfifo = Bun.spawnSync(["mkfifo", path]);
    expect(mkfifo.exitCode).toBe(0);

    const child = await runReaderInBoundedChild(path, root);
    expect(child).toEqual({
      exitCode: 0,
      stillAliveAfterOneSecond: false,
      stdout: JSON.stringify({
        status: "unavailable",
        reason: "Transcript path is not a regular file",
      }),
      stderr: "",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matches a real header symlink alias to the canonical expected cwd", async () => {
  const root = await makeRoot();
  const path = join(root, "alias.jsonl");
  const expectedCwd = join(root, "physical-project");
  const headerCwd = join(root, "project-alias");
  try {
    await mkdir(expectedCwd);
    await symlink(expectedCwd, headerCwd);
    await writeFile(path, jsonl([sessionMeta(headerCwd), message("accepted")]));

    expect(await read(path, expectedCwd)).toEqual({
      status: "ok",
      sessionId: "wanted",
      cwd: expectedCwd,
      messages: [{ role: "assistant", text: "accepted" }],
      truncated: false,
      contextTokens: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a header symlink alias to a different physical cwd", async () => {
  const root = await makeRoot();
  const path = join(root, "mismatch.jsonl");
  const expectedCwd = join(root, "expected-project");
  const otherCwd = join(root, "other-project");
  const headerCwd = join(root, "other-alias");
  try {
    await mkdir(expectedCwd);
    await mkdir(otherCwd);
    await symlink(otherCwd, headerCwd);
    await writeFile(path, jsonl([sessionMeta(headerCwd), message("PRIVATE_SENTINEL")]));

    const result = await read(path, expectedCwd);
    expect(result.status).toBe("identity_mismatch");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed before exposing messages when the header cwd symlink is broken", async () => {
  const root = await makeRoot();
  const path = join(root, "broken.jsonl");
  const expectedCwd = join(root, "expected-project");
  const headerCwd = join(root, "broken-alias");
  try {
    await mkdir(expectedCwd);
    await symlink(join(root, "missing-project"), headerCwd);
    await writeFile(path, jsonl([sessionMeta(headerCwd), message("PRIVATE_SENTINEL")]));

    const result = await read(path, expectedCwd);
    expect(result.status).toBe("identity_mismatch");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a lexically non-normalized expected cwd before path I/O", async () => {
  const root = await makeRoot();
  try {
    const result = await read(join(root, "not-read.jsonl"), `${root}/child/..`);
    expect(result).toEqual({
      status: "unsupported",
      reason: "Invalid Codex transcript reader options",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
