import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeJsonlReader } from "../../src/usage-readers/claude-jsonl-reader.js";

function setupProjectsDir(): { rootDir: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-projects-"));
  return { rootDir: root };
}

function writeJsonl(rootDir: string, project: string, sessionId: string, lines: object[]): string {
  const projDir = join(rootDir, project);
  mkdirSync(projDir, { recursive: true });
  const path = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

describe("ClaudeJsonlReader", () => {
  it("aggregates input + output tokens by model from assistant rows", async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, "-Volumes-WorkSSD-foo", "sess-1", [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
          usage: {
            input_tokens: 30,
            output_tokens: 40,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    const delta = first(r.usage_deltas);
    expect(delta.provider).toBe("anthropic");
    expect(delta.model).toBe("claude-opus-4-7");
    expect(delta.tokens_input).toBe(40);
    expect(delta.tokens_output).toBe(60);
    expect(delta.tokens_cache_read).toBe(15);
    expect(delta.tokens_cache_write).toBe(2);
    expect(delta.cost_usd).toBeNull();
  });

  it("cursor advances by file byte_offset; second call returns nothing for same content", async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, "-foo", "sess", [
      {
        type: "assistant",
        message: { model: "claude-opus-4-7", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r1 = await reader.read(null);
    expect(r1.usage_deltas).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.usage_deltas).toHaveLength(0);
  });

  it("skips non-assistant lines and rows without usage", async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, "-bar", "sess", [
      { type: "queue-operation", timestamp: "2026-04-28T12:00:00Z" },
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { model: "claude-opus-4-7" } },
      {
        type: "assistant",
        message: { model: "claude-opus-4-7", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(first(r.usage_deltas).tokens_input).toBe(1);
  });

  it("returns rate_limit_snapshots as an empty array even when JSONL includes rate_limits", async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, "-rate-limits", "sess", [
      {
        type: "assistant",
        message: {
          id: "msg_x",
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        rate_limits: {
          five_hour: { used_percentage: 50, resets_at: 1700000000 },
        },
      },
    ]);

    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toEqual([]);
    expect(r.usage_deltas).toHaveLength(1);
  });
});
