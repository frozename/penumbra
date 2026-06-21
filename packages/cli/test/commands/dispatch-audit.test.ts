import type { DispatchReliabilityReport } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatDispatchAudit, runDispatchAudit } from "../../src/commands/dispatch-audit.js";
import { urlToString } from "./_helpers.js";

const report = {
  handoff_id: "h-1",
  status: "watchdog_only",
  terminal: true,
  trustworthy: false,
  summary: "watchdog failed the handoff without dispatch.end",
  missing_events: ["dispatch.end"],
  evidence: {
    handoff_status: "failed",
    event_count: 3,
    response_count: 0,
    worktree_changed: null,
    reconciled: null,
    watchdog_failed: true,
    cancel_requested: false,
    adapter_streaming: null,
  },
  recommended_action: "retry",
} satisfies DispatchReliabilityReport;

let storageRoot = "";

describe("formatDispatchAudit", () => {
  test("formats human-readable audit output", () => {
    expect(formatDispatchAudit(report)).toBe(
      [
        "handoff: h-1",
        "status: watchdog_only",
        "trustworthy: no",
        "summary: watchdog failed the handoff without dispatch.end",
        "recommended_action: retry",
        "missing_events: dispatch.end",
      ].join("\n"),
    );
  });

  test("formats empty missing events as none", () => {
    expect(formatDispatchAudit({ ...report, missing_events: [] })).toContain(
      "missing_events: none",
    );
  });

  test("formats classifier declines as a dedicated safety-classifier block", () => {
    const withDecline: DispatchReliabilityReport = {
      ...report,
      classifier_decline: {
        classifier_declined: true,
        decline_reason: "provider_safety_refusal",
      },
    };
    expect(formatDispatchAudit(withDecline)).toContain(
      [
        "safety_classifier:",
        "  classifier_declined: yes",
        "  decline_reason: provider_safety_refusal",
      ].join("\n"),
    );
  });
});

describe("runDispatchAudit", () => {
  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), "penumbra-dispatch-audit-"));
    writeFileSync(join(storageRoot, "port"), "4242\n");
    writeFileSync(join(storageRoot, "token"), "tok\n");
  });

  afterEach(() => {
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  test("fetches dispatch audit with bearer auth and prints a readable report", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const printed: string[] = [];

    await runDispatchAudit({
      handoffId: "handoff-1",
      json: false,
      storageRoot,
      fetch: (url, init) => {
        calls.push({ url: urlToString(url), init });
        return Promise.resolve(
          new Response(JSON.stringify({ report }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
      print: (line) => {
        printed.push(line);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4242/dispatch/audit?handoff_id=handoff-1");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(printed.join("\n")).toContain("handoff: h-1");
    expect(printed.join("\n")).toContain("status: watchdog_only");
    expect(printed.join("\n")).toContain("trustworthy: no");
  });

  test("--json prints the raw report pretty-printed", async () => {
    let printed = "";

    await runDispatchAudit({
      handoffId: "handoff-2",
      json: true,
      storageRoot,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ report }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      print: (line) => {
        printed = line;
      },
    });

    expect(printed).toBe(JSON.stringify(report, null, 2));
  });
});
