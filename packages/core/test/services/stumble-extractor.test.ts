import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractStumblesFromSession,
  type SessionEventRow,
} from "../../src/services/stumble-extractor.js";

const storedRow: SessionEventRow = {
  source: "agentchat",
  event_type: "agent-response",
  payload_json: { prompt: "TODO: audit X from events" },
};

describe("extractStumblesFromSession", () => {
  test("empty transcript returns []", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stumble-empty-"));
    try {
      const out = await extractStumblesFromSession({
        session_id: "s-1",
        transcript_path: join(dir, "missing.txt"),
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TODO line yields one candidate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stumble-todo-"));
    try {
      const transcript = join(dir, "transcript.txt");
      writeFileSync(transcript, "TODO: audit X before shipping\n");

      const out = await extractStumblesFromSession({
        session_id: "s-2",
        transcript_path: transcript,
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.prompt).toContain("TODO: audit X");
      expect(out[0]?.evidence.session_id).toBe("s-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolver output wins over default project and empty default leaves affects_projects empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stumble-projects-"));
    try {
      const transcript = join(dir, "transcript.txt");
      writeFileSync(transcript, "TODO: audit X before shipping\n");

      const resolved = await extractStumblesFromSession({
        session_id: "s-2a",
        transcript_path: transcript,
        default_project: "fallback-project",
        affects_projects_resolver: () => ["resolved-a", "resolved-b"],
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.affects_projects).toEqual(["resolved-a", "resolved-b"]);

      const emptyDefault = await extractStumblesFromSession({
        session_id: "s-2b",
        transcript_path: transcript,
      });
      expect(emptyDefault).toHaveLength(1);
      expect(emptyDefault[0]?.affects_projects).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inline-filed task_draft in the session filters the duplicate transcript stumble", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stumble-dedupe-"));
    try {
      const transcript = join(dir, "transcript.txt");
      writeFileSync(transcript, "TODO: audit X before shipping!\n");
      const events: SessionEventRow[] = [
        {
          source: "agentchat",
          event_type: "task_draft",
          payload_json: {
            prompt: " todo:   audit X   before shipping. ",
          },
        },
      ];

      const out = await extractStumblesFromSession({
        session_id: "s-3",
        transcript_path: transcript,
        dispatch_events_query: () => Promise.resolve(events),
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repeated transcript lines dedupe within the same batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stumble-repeat-"));
    try {
      const transcript = join(dir, "transcript.txt");
      writeFileSync(transcript, "TODO: audit X before shipping.\nTODO: audit X before shipping!\n");

      const out = await extractStumblesFromSession({
        session_id: "s-4",
        transcript_path: transcript,
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.prompt).toBe("TODO: audit X before shipping.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rows with source not in allowed_sources are filtered out", async () => {
    const rows: SessionEventRow[] = [{ ...storedRow, source: "untrusted-source" }];
    const out = await extractStumblesFromSession({
      session_id: "s-src",
      dispatch_events_query: () => Promise.resolve(rows),
    });
    expect(out).toEqual([]);
  });

  test("rows with event_type not in allowed_event_types are filtered out", async () => {
    const rows: SessionEventRow[] = [{ ...storedRow, event_type: "custom-event" }];
    const out = await extractStumblesFromSession({
      session_id: "s-type",
      dispatch_events_query: () => Promise.resolve(rows),
    });
    expect(out).toEqual([]);
  });

  test("custom allowed_sources and allowed_event_types overrides produce candidates", async () => {
    const rows: SessionEventRow[] = [
      {
        source: "custom",
        event_type: "custom-event",
        payload_json: { prompt: "TODO: verify custom" },
      },
    ];
    const out = await extractStumblesFromSession({
      session_id: "s-custom",
      dispatch_events_query: () => Promise.resolve(rows),
      allowed_sources: ["custom"],
      allowed_event_types: ["custom-event"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.prompt).toBe("TODO: verify custom");
  });

  test("max_events_scanned and event_time_window_ms fields are accepted", async () => {
    const out = await extractStumblesFromSession({
      session_id: "s-caps",
      max_events_scanned: 100,
      event_time_window_ms: 60_000,
    });
    expect(out).toEqual([]);
  });

  test("multi-KB event payload is excerpted around the stumble signal", async () => {
    const leading = "A".repeat(2000);
    const trailing = "Z".repeat(2000);
    const signal = "we should also fix the workflow refresh trap soon";
    const longPrompt = `${leading} ${signal} ${trailing}`;

    const rows: SessionEventRow[] = [
      { source: "mcp", event_type: "agent-response", payload_json: { prompt: longPrompt } },
    ];

    const out = await extractStumblesFromSession({
      session_id: "s-excerpt",
      dispatch_events_query: () => Promise.resolve(rows),
    });

    expect(out).toHaveLength(1);
    const excerpt = out[0]!.prompt;
    expect(excerpt.length).toBeLessThan(longPrompt.length);
    expect(excerpt.length).toBeLessThanOrEqual(1000);
    expect(excerpt).toContain("should also");
    expect(excerpt).toContain("…");
  });
});
