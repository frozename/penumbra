import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexTranscript } from "@src/transcripts/codex.js";
import { resolveSessionTranscript } from "@src/transcripts/resolve.js";
import type {
  ReadCodexTranscriptOptions,
  ResolveSessionTranscriptInput,
  TranscriptReadResult,
} from "@src/transcripts/types.js";

const FORMAT = "penumbra-codex-rollout-fixture-v1";

function sessionMeta(cwd: string, sessionId = "wanted"): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
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

async function makeLayout(): Promise<{
  root: string;
  sessions: string;
  cwd: string;
  path: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-transcript-resolve-")));
  const sessions = join(root, "codex-home", "sessions");
  const cwd = join(root, "project");
  await mkdir(sessions, { recursive: true });
  await mkdir(cwd);
  const path = join(sessions, "wanted.jsonl");
  await writeFile(path, jsonl([sessionMeta(cwd), message("accepted")]));
  return { root, sessions: await realpath(sessions), cwd: await realpath(cwd), path };
}

function input(layout: {
  sessions: string;
  cwd: string;
  path: string;
}): ResolveSessionTranscriptInput {
  return {
    harness: "codex" as const,
    sessionId: "wanted",
    projectId: "project-a",
    cwd: layout.cwd,
    path: layout.path,
    format: FORMAT,
    allowedRoots: [layout.sessions],
  };
}

test("authorizes the canonical exact target and passes its identity to the reader", async () => {
  const layout = await makeLayout();
  let received: ReadCodexTranscriptOptions | null = null;
  try {
    const result = await resolveSessionTranscript(input(layout), {
      readTranscript: (options): Promise<TranscriptReadResult> => {
        received = options;
        return Promise.resolve({
          status: "ok",
          sessionId: "wanted",
          cwd: layout.cwd,
          messages: [{ role: "assistant", text: "accepted" }],
          truncated: false,
          contextTokens: null,
        });
      },
    });

    const target = await stat(layout.path, { bigint: true });
    expect(result.status).toBe("ok");
    expect(received).toMatchObject({
      path: await realpath(layout.path),
      expectedSessionId: "wanted",
      expectedCwd: layout.cwd,
      format: FORMAT,
      expectedFileIdentity: { dev: target.dev, ino: target.ino },
    });
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("rejects an outside target before invoking the transcript reader", async () => {
  const layout = await makeLayout();
  const outside = join(layout.root, "outside.jsonl");
  let readerCalls = 0;
  try {
    await writeFile(outside, jsonl([sessionMeta(layout.cwd), message("PRIVATE_SENTINEL")]));
    const result = await resolveSessionTranscript(
      { ...input(layout), path: outside },
      {
        readTranscript: (): Promise<TranscriptReadResult> => {
          readerCalls++;
          return Promise.resolve({ status: "unavailable", reason: "unexpected" });
        },
      },
    );

    expect(result.status).toBe("scope_violation");
    expect(readerCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("rejects lexical sibling prefixes and symlink escapes", async () => {
  const layout = await makeLayout();
  const sibling = `${layout.sessions}-other`;
  const outside = join(layout.root, "outside-target.jsonl");
  const escape = join(layout.sessions, "escape.jsonl");
  try {
    await mkdir(sibling);
    const siblingPath = join(sibling, "neighbor.jsonl");
    await writeFile(siblingPath, jsonl([sessionMeta(layout.cwd), message("SIBLING_SENTINEL")]));
    await writeFile(outside, jsonl([sessionMeta(layout.cwd), message("SYMLINK_SENTINEL")]));
    await symlink(outside, escape);

    expect((await resolveSessionTranscript({ ...input(layout), path: siblingPath })).status).toBe(
      "scope_violation",
    );
    expect((await resolveSessionTranscript({ ...input(layout), path: escape })).status).toBe(
      "scope_violation",
    );
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("fails closed for a broken symlink, a missing exact path, and an oversized file", async () => {
  const layout = await makeLayout();
  const broken = join(layout.sessions, "broken.jsonl");
  const neighbor = join(layout.sessions, "neighbor.jsonl");
  try {
    await symlink(join(layout.root, "missing-target.jsonl"), broken);
    await writeFile(neighbor, jsonl([sessionMeta(layout.cwd), message("NEIGHBOR_SENTINEL")]));

    expect((await resolveSessionTranscript({ ...input(layout), path: broken })).status).toBe(
      "unavailable",
    );
    expect(
      (
        await resolveSessionTranscript({
          ...input(layout),
          path: join(layout.sessions, "missing.jsonl"),
        })
      ).status,
    ).toBe("unavailable");

    await writeFile(
      layout.path,
      jsonl([sessionMeta(layout.cwd), message(`kept-${"x".repeat(1_100_000)}`)]),
    );
    const oversized = await resolveSessionTranscript(input(layout));
    expect(oversized).toMatchObject({ status: "ok", messages: [], truncated: true });
    expect(JSON.stringify(oversized)).not.toContain("NEIGHBOR_SENTINEL");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("accepts a separately captured trusted Codex sessions root", async () => {
  const layout = await makeLayout();
  const alternate = join(layout.root, "alternate-codex-home", "sessions");
  const alternatePath = join(alternate, "wanted.jsonl");
  try {
    await mkdir(alternate, { recursive: true });
    await writeFile(alternatePath, jsonl([sessionMeta(layout.cwd), message("alternate")]));
    const result = await resolveSessionTranscript({
      ...input(layout),
      path: alternatePath,
      allowedRoots: [alternate],
    });
    expect(result).toMatchObject({
      status: "ok",
      messages: [{ role: "assistant", text: "alternate" }],
    });
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("detects replacement between resolver authorization and reader open", async () => {
  const layout = await makeLayout();
  const displaced = join(layout.sessions, "displaced.jsonl");
  try {
    const result = await resolveSessionTranscript(input(layout), {
      readTranscript: async (options): Promise<TranscriptReadResult> => {
        await rename(layout.path, displaced);
        await writeFile(layout.path, jsonl([sessionMeta(layout.cwd), message("REPLACEMENT")]));
        return await readCodexTranscript(options);
      },
    });

    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("REPLACEMENT");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});
