import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexTranscript } from "@src/transcripts/codex.js";

test("an unqualified captured format cannot expose transcript text", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-transcript-")));
  const path = join(root, "synthetic-negative.jsonl");
  await writeFile(
    path,
    [
      JSON.stringify({ type: "session_meta", payload: { id: "wanted", cwd: root } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "PRIVATE_SENTINEL" }],
        },
      }),
    ].join("\n") + "\n",
  );

  try {
    const result = await readCodexTranscript({
      path,
      expectedSessionId: "wanted",
      expectedCwd: root,
      format: "penumbra-codex-rollout-fixture-v1",
    });
    expect(result).toEqual({
      status: "unsupported",
      reason: "Codex transcript format is not qualified by a complete disposable capture",
    });
    expect("messages" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown format is rejected without requiring a readable path", async () => {
  const result = await readCodexTranscript({
    path: "/not/read/for/an/unsupported/format.jsonl",
    expectedSessionId: "wanted",
    expectedCwd: "/canonical/cwd",
    format: "unknown-format",
  });

  expect(result.status).toBe("unsupported");
  expect("messages" in result).toBe(false);
});

test("capture evidence keeps the fixture fingerprint disabled", async () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
  const evidence = JSON.parse(
    await readFile(join(fixtureDir, "capture-evidence.json"), "utf8"),
  ) as {
    status: string;
    assistantMessageObserved: boolean;
    sanitization: { syntheticRowsAdded: boolean };
    format: { fingerprint: string; status: string; enabled: boolean };
  };

  expect(evidence.status).toBe("unavailable");
  expect(evidence.assistantMessageObserved).toBe(false);
  expect(evidence.sanitization.syntheticRowsAdded).toBe(false);
  expect(evidence.format).toMatchObject({
    fingerprint: "penumbra-codex-rollout-fixture-v1",
    status: "unsupported",
    enabled: false,
  });
  expect(existsSync(join(fixtureDir, "session-sanitized.jsonl"))).toBe(false);
});
