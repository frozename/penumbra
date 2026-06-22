import {
  FsEditAppliedPayload,
  FsWriteAppliedPayload,
  TerminalExitedPayload,
  TerminalKilledPayload,
  TerminalSpawnedPayload,
} from "@penumbra/core";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { withSandboxedExecutor } from "../helpers/sandbox-fixtures.js";

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected item at index ${String(index)}`);
  return item;
}

describe("Phase 1d audit events end-to-end", () => {
  // 1. fs.write_applied schema
  test("fs.write_applied event matches FsWriteAppliedPayload schema", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "a.txt", content: "hello" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const event = events.find((e) => e.type === "fs.write_applied")!;
      expect(event).toBeDefined();
      expect(() => FsWriteAppliedPayload.parse(event.payload)).not.toThrow();
    });
  });

  // 2. fs.edit_applied schema
  test("fs.edit_applied event matches FsEditAppliedPayload schema", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "b.txt", content: "foo" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.editTextFile(
        { path: "b.txt", old_string: "foo", new_string: "bar" },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const event = events.find((e) => e.type === "fs.edit_applied")!;
      expect(event).toBeDefined();
      const parsed = FsEditAppliedPayload.parse(event.payload);
      expect(parsed.bytes_added).toBe(3);
      expect(parsed.bytes_removed).toBe(3);
    });
  });

  // 3. terminal.spawned schema
  test("terminal.spawned event matches TerminalSpawnedPayload schema with env_keys", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["echo", "x"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const event = events.find((e) => e.type === "terminal.spawned")!;
      expect(event).toBeDefined();
      const parsed = TerminalSpawnedPayload.parse(event.payload);
      expect(parsed.argv).toEqual(["echo", "x"]);
      expect(Array.isArray(parsed.env_keys)).toBe(true);
      expect(parsed.env_keys.includes("PATH")).toBe(true);
    });
  });

  // 4. terminal.exited schema
  test("terminal.exited event matches TerminalExitedPayload schema with duration_ms", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["echo", "done"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const event = events.find((e) => e.type === "terminal.exited")!;
      expect(event).toBeDefined();
      const parsed = TerminalExitedPayload.parse(event.payload);
      expect(parsed.exit_code).toBe(0);
      expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
      expect(parsed.duration_ms).toBeLessThan(5000);
    });
  });

  // 5. terminal.killed schema with reason enum
  test("terminal.killed event matches TerminalKilledPayload schema (reason=operator)", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["sleep", "5"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalKill({ terminal_id });
      const event = events.find((e) => {
        if (e.type !== "terminal.killed") return false;
        const result = TerminalKilledPayload.safeParse(e.payload);
        return result.success && result.data.reason === "operator";
      })!;
      expect(event).toBeDefined();
      expect(() => TerminalKilledPayload.parse(event.payload)).not.toThrow();
    });
  });

  // 6. sha256 stability
  test("same content produces same sha256 across multiple writes", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "a.txt", content: "stable" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.writeTextFile(
        { path: "b.txt", content: "stable" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const writes = events.filter((e) => e.type === "fs.write_applied");
      expect(writes.length).toBe(2);
      const sha1 = FsWriteAppliedPayload.parse(at(writes, 0).payload).sha256;
      const sha2 = FsWriteAppliedPayload.parse(at(writes, 1).payload).sha256;
      expect(sha1).toBe(sha2);
      expect(sha1).toBe(createHash("sha256").update("stable").digest("hex"));
    });
  });

  // 7. relative paths in events (not absolute)
  test("fs.write_applied path is relative to worktree, not absolute", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "sub/dir/file.txt", content: "x" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const event = events.find((e) => e.type === "fs.write_applied")!;
      const parsed = FsWriteAppliedPayload.parse(event.payload);
      expect(parsed.path).toBe("sub/dir/file.txt");
      expect(parsed.path).not.toMatch(/^\/(tmp|var|private)/);
    });
  });

  // 8. env_keys are NAMES only, not values
  test("terminal.spawned env_keys contains key names, not values", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["echo", "x"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const event = events.find((e) => e.type === "terminal.spawned")!;
      const parsed = TerminalSpawnedPayload.parse(event.payload);
      const envKeys = parsed.env_keys;
      // env_keys should be like ['PATH', 'HOME', 'CI', 'TERM'] — string names
      for (const key of envKeys) {
        expect(typeof key).toBe("string");
        expect(key.length).toBeLessThan(50); // env var names are short; values can be long
      }
      // No value-like content
      const joined = envKeys.join("|");
      expect(joined).not.toContain("/"); // PATH values would have /
    });
  });

  // 9. handoff_id present on every event
  test("every Phase 1d event carries handoff_id", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "a.txt", content: "hi" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["echo", "y"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const phase1dEvents = events.filter((e) =>
        [
          "fs.write_applied",
          "fs.edit_applied",
          "terminal.spawned",
          "terminal.exited",
          "terminal.killed",
        ].includes(e.type),
      );
      expect(phase1dEvents.length).toBeGreaterThan(0);
      for (const e of phase1dEvents) {
        const payload = e.payload;
        if (typeof payload !== "object" || payload === null) {
          throw new Error("event.payload must be an object");
        }
        const handoffId = (payload as { handoff_id?: unknown }).handoff_id;
        expect(handoffId).toBe("h-test");
      }
    });
  });

  // 10. successful write ordering (write event after permission decision)
  test("successful write produces fs.write_applied (no permission events here since no daemon round-trip in fixture)", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "a.txt", content: "x" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const writes = events.filter((e) => e.type === "fs.write_applied");
      expect(writes.length).toBe(1);
    });
  });

  // 11. denial → no fs.write_applied event
  test("permission-rejected write produces NO fs.write_applied event", async () => {
    await withSandboxedExecutor(async ({ executor, events, pushDecision }) => {
      pushDecision("reject");
      try {
        await executor.writeTextFile(
          { path: "denied.txt", content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        );
      } catch {
        /* expected */
      }
      expect(events.filter((e) => e.type === "fs.write_applied").length).toBe(0);
    });
  });

  // 12. post-approval validation failure produces NO fs.write_applied event
  test("post-approval failure (write to a directory path) produces NO fs.write_applied event", async () => {
    await withSandboxedExecutor(async ({ executor, events, worktreeRoot }) => {
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(worktreeRoot, "dirpath"));
      try {
        await executor.writeTextFile(
          { path: "dirpath", content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        );
      } catch {
        /* expected NotAFileError */
      }
      expect(events.filter((e) => e.type === "fs.write_applied").length).toBe(0);
    });
  });

  // 13. terminal.exited duration is reasonable (within 100ms accuracy of measured wall time)
  test("terminal.exited duration_ms accuracy", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const wallStart = Date.now();
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["sleep", "0.3"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const wallEnd = Date.now();
      const event = events.find((e) => e.type === "terminal.exited")!;
      const parsed = TerminalExitedPayload.parse(event.payload);
      const durationMs = parsed.duration_ms;
      // sleep 0.3 ≈ 300ms, allow [200, 800] window for sandbox overhead
      expect(durationMs).toBeGreaterThanOrEqual(200);
      expect(durationMs).toBeLessThanOrEqual(wallEnd - wallStart + 100);
    });
  });

  // 14. fs.write_applied event raw bytes — confirm content not in payload
  test("fs.write_applied payload does NOT contain the raw content", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const big = "x".repeat(10_000);
      await executor.writeTextFile(
        { path: "big.txt", content: big },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const event = events.find((e) => e.type === "fs.write_applied")!;
      const parsed = FsWriteAppliedPayload.parse(event.payload);
      expect(parsed.bytes).toBe(10_000);
      const payloadStr = JSON.stringify(event.payload);
      expect(payloadStr.length).toBeLessThan(500); // sha256 + path + bytes + handoff_id, no content
      expect(payloadStr.includes(big)).toBe(false);
    });
  });

  // 15. ts field — events have a timestamp implicitly via T0 emission (fixture's auditEmitter doesn't add ts; this test verifies the fixture itself stays consistent)
  test("event capture order is deterministic (most recent at end of array)", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "a.txt", content: "1" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.writeTextFile(
        { path: "b.txt", content: "2" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const writes = events.filter((e) => e.type === "fs.write_applied");
      expect(writes.length).toBe(2);
      expect(FsWriteAppliedPayload.parse(at(writes, 0).payload).path).toBe("a.txt");
      expect(FsWriteAppliedPayload.parse(at(writes, 1).payload).path).toBe("b.txt");
    });
  });
});
