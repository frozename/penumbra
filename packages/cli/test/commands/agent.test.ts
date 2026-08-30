import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAgentLedgerAdd,
  runAgentLedgerImport,
  runAgentLedgerRender,
  runAgentRank,
} from "@src/commands/agent.js";

import { expectAsyncThrow, parseJson, urlToString } from "./_helpers.js";

describe("runAgentRank", () => {
  it("prints JSON when requested", async () => {
    const lines: string[] = [];
    let requestedUrl = "";
    await runAgentRank({
      task_type: "implement_substantial",
      json: true,
      include_cost: true,
      fetch: (url) => {
        requestedUrl = urlToString(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              task_type: "implement_substantial",
              window: { from: "a", to: "b" },
              candidates: [],
            }),
          ),
        );
      },
      print: (s) => lines.push(s),
    });
    expect(requestedUrl).toContain("include_cost=true");
    expect(parseJson(lines.join("\n"))).toEqual({
      task_type: "implement_substantial",
      window: { from: "a", to: "b" },
      candidates: [],
    });
  });

  it("prints a compact table", async () => {
    const lines: string[] = [];
    await runAgentRank({
      task_type: "implement_substantial",
      json: false,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              task_type: "implement_substantial",
              window: { from: null, to: "2026-04-30T00:00:00Z" },
              candidates: [
                {
                  agent_name: "claude",
                  score: 0.9,
                  samples: 2,
                  successes: 2,
                  failures: 0,
                  neutral: 0,
                  success_rate: 1,
                  avg_rounds: 1,
                  avg_latency_ms: 60000,
                  cost_per_success_usd: 0.25,
                  avg_reviewer_findings: 0,
                  last_outcome_at: "2026-04-29T12:00:00Z",
                },
              ],
            }),
          ),
        ),
      print: (s) => lines.push(s),
    });
    expect(lines.join("\n")).toContain("Agent rank -- task_type=implement_substantial");
    expect(lines.join("\n")).toContain("window all-time");
    expect(lines.join("\n")).toContain("claude");
    expect(lines.join("\n")).toContain("90.0%");
  });
});

describe("runAgentLedgerAdd", () => {
  it("posts the parsed payload and prints the returned row", async () => {
    const lines: string[] = [];
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const performance = {
      performance_id: "perf-1",
      ts: "2026-05-02T12:00:00.000Z",
      handoff_id: "h1",
      conversation_id: "c1",
      project_id: null,
      agent_name: "codex",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.12,
      tokens_used: null,
      latency_ms: null,
      source: "operator",
      notes: "Clean",
      metadata_json: "{}",
    };

    await runAgentLedgerAdd({
      handoff_id: "h1",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.12,
      notes: "Clean",
      json: true,
      fetch: (url, init) => {
        requestedUrl = urlToString(url);
        requestedInit = init;
        return Promise.resolve(new Response(JSON.stringify({ performance })));
      },
      print: (s) => lines.push(s),
    });

    expect(requestedUrl).toBe("/agents/performance/operator");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toEqual({ "content-type": "application/json" });
    const ledgerAddBody = typeof requestedInit?.body === "string" ? requestedInit.body : "";
    expect(parseJson(ledgerAddBody)).toEqual({
      handoff_id: "h1",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.12,
      notes: "Clean",
    });
    expect(parseJson(lines.join("\n"))).toEqual(performance);
  });

  it("surfaces daemon non-2xx responses as an Error", async () => {
    await expectAsyncThrow(
      runAgentLedgerAdd({
        handoff_id: "h1",
        task_type: "implement_small",
        outcome: "merged",
        json: false,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
          ),
      }),
      "penumbra agent ledger add: daemon /agents/performance/operator returned HTTP 400",
    );
  });
});

describe("runAgentLedgerImport", () => {
  it("reads markdown, posts it to the daemon, and prints counts", async () => {
    const lines: string[] = [];
    const tempDir = mkdtempSync(join(tmpdir(), "penumbra-agent-import-"));
    const inputPath = join(tempDir, "ledger.md");
    writeFileSync(inputPath, "# Agent performance ledger\n");

    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    await runAgentLedgerImport({
      from: inputPath,
      fetch: (url, init) => {
        requestedUrl = urlToString(url);
        requestedInit = init;
        return Promise.resolve(new Response(JSON.stringify({ imported: 3, skipped: 1 })));
      },
      print: (s) => lines.push(s),
    });

    expect(requestedUrl).toBe("/agents/performance/import-markdown");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toEqual({ "content-type": "application/json" });
    const ledgerImportBody = typeof requestedInit?.body === "string" ? requestedInit.body : "";
    expect(parseJson(ledgerImportBody)).toEqual({
      markdown: "# Agent performance ledger\n",
      sourcePath: inputPath,
      projectId: null,
    });
    expect(lines).toEqual(["imported: 3, skipped: 1"]);
  });
});

describe("runAgentLedgerRender", () => {
  const stdoutWrite = mock<typeof process.stdout.write>(() => true);
  const stderrWrite = mock<typeof process.stderr.write>(() => true);

  afterEach(() => {
    stdoutWrite.mockReset();
    stderrWrite.mockReset();
  });

  it("writes the markdown response to opts.out and prints confirmation", async () => {
    const lines: string[] = [];
    const tempDir = mkdtempSync(join(tmpdir(), "penumbra-agent-render-"));
    const outputPath = join(tempDir, "ledger.md");

    let requestedUrl = "";
    await runAgentLedgerRender({
      out: outputPath,
      fetch: (url) => {
        requestedUrl = urlToString(url);
        return Promise.resolve(new Response("# Agent performance ledger\n"));
      },
      print: (s) => lines.push(s),
      stdoutWrite,
      stderrWrite,
    });

    expect(requestedUrl).toBe("/agents/performance/markdown");
    expect(readFileSync(outputPath, "utf8")).toBe("# Agent performance ledger\n");
    expect(lines).toEqual([`wrote ledger to ${outputPath}`]);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });
});
