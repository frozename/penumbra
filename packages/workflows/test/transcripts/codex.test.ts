import { expect, test } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexTranscript } from "@src/transcripts/codex.js";
import type { TranscriptReadResult } from "@src/transcripts/types.js";

const FORMAT = "penumbra-codex-rollout-fixture-v1";
const FIXTURE_CWD = "/fixture/penumbra-codex-session";
const FIXTURE_SESSION_ID = "fixture-session";

type JsonRecord = Record<string, unknown>;

function sessionMeta(
  cwd: string,
  id = "wanted",
  overrides: Record<string, unknown> = {},
): JsonRecord {
  return {
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      cwd,
      originator: "codex_exec",
      cli_version: "0.153.4",
      source: "exec",
      ...overrides,
    },
  };
}

function message(role: "user" | "assistant", text: string): JsonRecord {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

function jsonl(records: JsonRecord[], finalNewline = true): string {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  return finalNewline ? `${body}\n` : body;
}

async function makeSyntheticRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "codex-transcript-synthetic-negative-")));
}

async function readSynthetic(
  path: string,
  expectedCwd: string,
  expectedSessionId = "wanted",
  caps: { maxBytes?: number; maxEvents?: number } = {},
): Promise<TranscriptReadResult> {
  const target = await stat(path, { bigint: true });
  return await readCodexTranscript({
    path,
    expectedSessionId,
    expectedCwd,
    format: FORMAT,
    expectedFileIdentity: { dev: target.dev, ino: target.ino },
    ...caps,
  });
}

test("reads the supplied disposable CLI capture without event_msg duplicates", async () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
  const fixturePath = join(fixtureDir, "session-sanitized.jsonl");
  const root = await makeSyntheticRoot();
  const path = join(root, "session-sanitized.jsonl");
  try {
    const lines = (await readFile(fixturePath, "utf8")).trimEnd().split("\n");
    const header = JSON.parse(lines[0] ?? "") as { payload: { cwd: string } };
    header.payload.cwd = root;
    await writeFile(path, `${[JSON.stringify(header), ...lines.slice(1)].join("\n")}\n`);

    const result = await readCodexTranscript({
      path,
      expectedSessionId: FIXTURE_SESSION_ID,
      expectedCwd: root,
      format: FORMAT,
      expectedFileIdentity: await stat(path, { bigint: true }).then(({ dev, ino }) => ({
        dev,
        ino,
      })),
    });

    expect(result).toEqual({
      status: "ok",
      sessionId: FIXTURE_SESSION_ID,
      cwd: root,
      messages: [
        {
          role: "user",
          text: "This is a disposable transcript-format qualification session. Do not call tools or read files. Reply exactly: PENUMBRA_DISPOSABLE_TRANSCRIPT_OK",
        },
        { role: "assistant", text: "PENUMBRA_DISPOSABLE_TRANSCRIPT_OK" },
      ],
      truncated: false,
      contextTokens: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown or absent format before requiring a readable path", async () => {
  const base = {
    path: "/not/read/for/an/unsupported/format.jsonl",
    expectedSessionId: "wanted",
    expectedCwd: "/canonical/cwd",
    expectedFileIdentity: { dev: 0n, ino: 0n },
  };

  expect((await readCodexTranscript({ ...base, format: "unknown-format" })).status).toBe(
    "unsupported",
  );
  expect(
    (
      await readCodexTranscript({
        ...base,
        format: undefined as unknown as string,
      })
    ).status,
  ).toBe("unsupported");
});

test("rejects invalid byte and event caps deterministically before path I/O", async () => {
  const base = {
    path: "/not/read/for/invalid/options.jsonl",
    expectedSessionId: "wanted",
    expectedCwd: "/canonical/cwd",
    format: FORMAT,
    expectedFileIdentity: { dev: 0n, ino: 0n },
  };

  for (const maxBytes of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const result = await readCodexTranscript({ ...base, maxBytes });
    expect(result.status).toBe("unsupported");
    expect(result).toHaveProperty("reason", "Invalid maxBytes");
  }
  for (const maxEvents of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const result = await readCodexTranscript({ ...base, maxEvents });
    expect(result.status).toBe("unsupported");
    expect(result).toHaveProperty("reason", "Invalid maxEvents");
  }
});

test("returns unavailable for an exact path that does not exist", async () => {
  const result = await readCodexTranscript({
    path: join(tmpdir(), "codex-transcript-does-not-exist", "session.jsonl"),
    expectedSessionId: "wanted",
    expectedCwd: "/canonical/cwd",
    format: FORMAT,
    expectedFileIdentity: { dev: 0n, ino: 0n },
  });

  expect(result.status).toBe("unavailable");
  expect("messages" in result).toBe(false);
});

test("rejects an unexpected descriptor identity before parsing its header", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "unexpected-identity.jsonl");
  try {
    await writeFile(
      path,
      jsonl([sessionMeta(root, "wrong-session"), message("user", "PRIVATE_SENTINEL")]),
    );

    const result = await readCodexTranscript({
      path,
      expectedSessionId: "wanted",
      expectedCwd: root,
      format: FORMAT,
      expectedFileIdentity: { dev: 0n, ino: 0n },
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "Transcript descriptor identity does not match authorization",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects a neighboring session even when cwd matches", async () => {
  const root = await makeSyntheticRoot();
  const wantedPath = join(root, "wanted.jsonl");
  const neighborPath = join(root, "neighbor.jsonl");
  try {
    await writeFile(wantedPath, jsonl([sessionMeta(root), message("user", "wanted text")]));
    await writeFile(
      neighborPath,
      jsonl([sessionMeta(root, "neighbor"), message("user", "NEIGHBOR_PRIVATE_SENTINEL")]),
    );

    const result = await readSynthetic(neighborPath, root);
    expect(result.status).toBe("identity_mismatch");
    expect("messages" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("NEIGHBOR_PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: keeps same-cwd session IDs distinct", async () => {
  const root = await makeSyntheticRoot();
  const firstPath = join(root, "first.jsonl");
  const secondPath = join(root, "second.jsonl");
  try {
    await writeFile(firstPath, jsonl([sessionMeta(root, "first"), message("user", "first")]));
    await writeFile(secondPath, jsonl([sessionMeta(root, "second"), message("user", "second")]));

    expect((await readSynthetic(firstPath, root, "first")).status).toBe("ok");
    expect((await readSynthetic(secondPath, root, "first")).status).toBe("identity_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects conflicting id and session_id", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "conflicting-id.jsonl");
  try {
    await writeFile(
      path,
      jsonl([
        sessionMeta(root, "wanted", { session_id: "other" }),
        message("user", "PRIVATE_SENTINEL"),
      ]),
    );

    const result = await readSynthetic(path, root);
    expect(result.status).toBe("identity_mismatch");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects repeated session headers", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "repeated-header.jsonl");
  try {
    await writeFile(
      path,
      jsonl([sessionMeta(root), message("user", "PRIVATE_SENTINEL"), sessionMeta(root)]),
    );

    const result = await readSynthetic(path, root);
    expect(result.status).toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects a canonical cwd mismatch", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "cwd-mismatch.jsonl");
  try {
    await writeFile(path, jsonl([sessionMeta(join(root, "other")), message("user", "secret")]));

    const result = await readSynthetic(path, join(root, "project"));
    expect(result.status).toBe("identity_mismatch");
    expect("messages" in result).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: fails closed on absent or unknown captured metadata", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "metadata.jsonl");
  const invalidPayloads: Record<string, unknown>[] = [
    {
      session_id: "wanted",
      cwd: root,
      originator: "codex_exec",
      cli_version: "0.153.4",
      source: "exec",
    },
    { id: "wanted", cwd: root, originator: "codex_exec", cli_version: "0.153.4", source: "exec" },
    {
      id: "wanted",
      session_id: "wanted",
      originator: "codex_exec",
      cli_version: "0.153.4",
      source: "exec",
    },
    { id: "wanted", session_id: "wanted", cwd: root, cli_version: "0.153.4", source: "exec" },
    { id: "wanted", session_id: "wanted", cwd: root, originator: "codex_exec", source: "exec" },
    {
      id: "wanted",
      session_id: "wanted",
      cwd: root,
      originator: "codex_exec",
      cli_version: "0.153.4",
    },
    {
      id: "wanted",
      session_id: "wanted",
      cwd: root,
      originator: "desktop",
      cli_version: "0.153.4",
      source: "exec",
    },
    {
      id: "wanted",
      session_id: "wanted",
      cwd: root,
      originator: "codex_exec",
      cli_version: "0.154.0",
      source: "exec",
    },
  ];
  try {
    for (const payload of invalidPayloads) {
      await writeFile(
        path,
        jsonl([{ type: "session_meta", payload }, message("user", "PRIVATE_SENTINEL")]),
      );
      const result = await readSynthetic(path, root);
      expect(result.status).toBe("unsupported");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects a malformed identity header", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "malformed-header.jsonl");
  try {
    await writeFile(path, `{not-json}\n${jsonl([message("user", "PRIVATE_SENTINEL")])}`);

    const result = await readSynthetic(path, root);
    expect(result.status).toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips malformed content lines after validating identity", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "malformed-content.jsonl");
  try {
    await writeFile(
      path,
      `${JSON.stringify(sessionMeta(root))}\n{not-json}\n${JSON.stringify(message("assistant", "kept"))}\n`,
    );

    const result = await readSynthetic(path, root);
    expect(result).toMatchObject({
      status: "ok",
      messages: [{ role: "assistant", text: "kept" }],
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects an identity header that exceeds 64 KiB", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "oversized-header.jsonl");
  try {
    await writeFile(
      path,
      jsonl([
        sessionMeta(root, "wanted", { padding: "x".repeat(65_536) }),
        message("user", "PRIVATE_SENTINEL"),
      ]),
    );

    const result = await readSynthetic(path, root);
    expect(result.status).toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic negative: rejects an identity header truncated by the byte cap", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "capped-header.jsonl");
  try {
    await writeFile(path, jsonl([sessionMeta(root), message("user", "PRIVATE_SENTINEL")]));

    const result = await readSynthetic(path, root, "wanted", { maxBytes: 16 });
    expect(result.status).toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discards a partial trailing content line without inventing truncation", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "partial-tail.jsonl");
  try {
    const complete = `${JSON.stringify(sessionMeta(root))}\n${JSON.stringify(message("user", "kept"))}\n`;
    await writeFile(path, `${complete}{"type":"response_item","payload":`);

    const result = await readSynthetic(path, root);
    expect(result).toMatchObject({
      status: "ok",
      messages: [{ role: "user", text: "kept" }],
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counts identity bytes inside the real descriptor byte budget", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "byte-budget.jsonl");
  try {
    const header = `${JSON.stringify(sessionMeta(root))}\n`;
    const first = `${JSON.stringify(message("user", "inside-budget"))}\n`;
    const outside = `${JSON.stringify(message("assistant", "OUTSIDE_BUDGET_SENTINEL"))}\n`;
    await writeFile(path, `${header}${first}${outside}`);

    const result = await readSynthetic(path, root, "wanted", {
      maxBytes: Buffer.byteLength(header) + Buffer.byteLength(first),
    });
    expect(result).toMatchObject({
      status: "ok",
      messages: [{ role: "user", text: "inside-budget" }],
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain("OUTSIDE_BUDGET_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds an individual content line that exceeds the remaining byte budget", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "oversized-content-line.jsonl");
  try {
    await writeFile(path, jsonl([sessionMeta(root), message("user", "x".repeat(16_000))]));

    const result = await readSynthetic(path, root, "wanted", { maxBytes: 4_096 });
    expect(result).toMatchObject({ status: "ok", messages: [], truncated: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses a large complete content line without a fixed line buffer", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "large-content-line.jsonl");
  const text = `start-${"x".repeat(100_000)}-end`;
  try {
    await writeFile(path, jsonl([sessionMeta(root), message("assistant", text)]));

    const result = await readSynthetic(path, root);
    expect(result).toMatchObject({
      status: "ok",
      messages: [{ role: "assistant", text }],
      truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps extracted message events and reports content truncation", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "event-cap.jsonl");
  try {
    await writeFile(
      path,
      jsonl([
        sessionMeta(root),
        message("user", "first"),
        { type: "event_msg", payload: { type: "item_completed" } },
        message("assistant", "SECOND_EVENT_SENTINEL"),
      ]),
    );

    const result = await readSynthetic(path, root, "wanted", { maxEvents: 1 });
    expect(result).toMatchObject({
      status: "ok",
      messages: [{ role: "user", text: "first" }],
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain("SECOND_EVENT_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults to at most 2000 extracted message events", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "default-event-cap.jsonl");
  try {
    const messages = Array.from({ length: 2_001 }, (_, index) =>
      message("user", `message-${String(index)}`),
    );
    await writeFile(path, jsonl([sessionMeta(root), ...messages]));

    const result = await readSynthetic(path, root);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected supported transcript");
    expect(result.messages).toHaveLength(2_000);
    expect(result.messages.at(-1)?.text).toBe("message-1999");
    expect(result.truncated).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults to a 1 MiB total descriptor byte budget", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "default-byte-cap.jsonl");
  try {
    await writeFile(path, jsonl([sessionMeta(root), message("user", "x".repeat(1_100_000))]));

    const result = await readSynthetic(path, root);
    expect(result).toMatchObject({ status: "ok", messages: [], truncated: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves multibyte text split across descriptor read chunks", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "unicode-boundary.jsonl");
  try {
    const header = `${JSON.stringify(sessionMeta(root))}\n`;
    const marker = "UNICODE_MARKER";
    const template = JSON.stringify(message("user", marker));
    const markerIndex = template.indexOf(marker);
    const bytesBeforeText = Buffer.byteLength(`${header}${template.slice(0, markerIndex)}`);
    const paddingBytes = (16_383 - (bytesBeforeText % 16_384) + 16_384) % 16_384;
    const text = `${"a".repeat(paddingBytes)}🪶fim`;
    const body = `${header}${JSON.stringify(message("user", text))}\n`;
    const emojiIndex = body.indexOf("🪶");
    expect(Buffer.byteLength(body.slice(0, emojiIndex)) % 16_384).toBe(16_383);
    await writeFile(path, body);

    const result = await readSynthetic(path, root);
    expect(result).toMatchObject({ messages: [{ role: "user", text }] });
    expect(JSON.stringify(result)).not.toContain("�");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts only captured message text and strips privacy tags", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "message-filtering.jsonl");
  try {
    const userMessage = message("user", "keep <private>drop-me</private> visible");
    const assistantMessage = message(
      "assistant",
      "answer <private>nested <private>x</private></private> done",
    );
    (userMessage.payload as { content: unknown[] }).content.push({
      type: "tool_call",
      text: "TOOL_BLOCK_SENTINEL",
    });
    (assistantMessage.payload as { content: unknown[] }).content.push({
      type: "reasoning",
      text: "REASONING_SENTINEL",
    });
    await writeFile(
      path,
      jsonl([
        sessionMeta(root),
        { type: "response_item", payload: { type: "function_call", name: "PRIVATE_TOOL" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "DEVELOPER_SENTINEL" }],
          },
        },
        {
          type: "event_msg",
          payload: {
            item: { type: "AgentMessage", content: [{ type: "Text", text: "DUPLICATE_SENTINEL" }] },
          },
        },
        userMessage,
        assistantMessage,
      ]),
    );

    const result = await readSynthetic(path, root);
    expect(result).toMatchObject({
      status: "ok",
      messages: [
        { role: "user", text: "keep  visible" },
        { role: "assistant", text: "answer  done" },
      ],
      contextTokens: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /TOOL_BLOCK_SENTINEL|REASONING_SENTINEL|PRIVATE_TOOL|DEVELOPER_SENTINEL|DUPLICATE_SENTINEL|drop-me|nested/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns unavailable when the descriptor snapshot is appended during the read", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "append-race.jsonl");
  try {
    await writeFile(path, jsonl([sessionMeta(root), message("user", "x".repeat(8_000_000))]));
    const reading = readSynthetic(path, root, "wanted", { maxBytes: 9_000_000 });
    await new Promise((resolveMutation, rejectMutation) => {
      setTimeout(() => {
        appendFile(path, JSON.stringify(message("assistant", "late")) + "\n").then(
          resolveMutation,
          rejectMutation,
        );
      }, 1);
    });

    expect((await reading).status).toBe("unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns unavailable when the exact path is replaced while its old descriptor is open", async () => {
  const root = await makeSyntheticRoot();
  const path = join(root, "replace-race.jsonl");
  const displacedPath = join(root, "displaced.jsonl");
  try {
    await writeFile(path, jsonl([sessionMeta(root), message("user", "x".repeat(8_000_000))]));
    const reading = readSynthetic(path, root, "wanted", { maxBytes: 9_000_000 });
    await new Promise((resolveMutation, rejectMutation) => {
      setTimeout(() => {
        rename(path, displacedPath)
          .then(async () => {
            await writeFile(path, jsonl([sessionMeta(root, "replacement")]));
          })
          .then(resolveMutation, rejectMutation);
      }, 1);
    });

    const result = await reading;
    expect(result.status).toBe("unavailable");
    expect("messages" in result).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture evidence records the exact supplied complete CLI fixture", async () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
  const evidence = JSON.parse(
    await readFile(join(fixtureDir, "capture-evidence.json"), "utf8"),
  ) as {
    status: string;
    assistantMessageObserved: boolean;
    sanitization: { fixtureSha256: string; syntheticRowsAdded: boolean };
    format: { fingerprint: string; status: string; enabled: boolean };
    coverage: { cli: string; desktop: string };
  };

  expect(evidence.status).toBe("captured");
  expect(evidence.assistantMessageObserved).toBe(true);
  expect(evidence.sanitization).toMatchObject({
    fixtureSha256: "46331e9326e7950fc9a10068ebbd1c222429c0c9c1f6f1d00edbf915248af46c",
    syntheticRowsAdded: false,
  });
  expect(evidence.format).toMatchObject({
    fingerprint: FORMAT,
    status: "supported",
    enabled: true,
  });
  expect(evidence.coverage).toEqual({
    cli: "complete disposable user and assistant capture at0.153.4",
    desktop: "unverified",
  });
  expect(resolve(FIXTURE_CWD)).toBe(FIXTURE_CWD);
});
