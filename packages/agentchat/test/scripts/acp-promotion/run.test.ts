import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAcpPromotion } from "../../../scripts/acp-promotion/run.js";

function configFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "acp-promotion-cfg-"));
  const path = join(dir, "agentchat.yaml");
  writeFileSync(
    path,
    `
agents:
  - name: gemini-acp-pro
    adapter: stdio-acp
    options: { binary: gemini, fsReadTextFile: true, fsWriteTextFile: true, terminal: true }
  - name: gemini
    adapter: gemini-cli
    options: { command: cat }
default_roles: {}
`,
  );
  return {
    path,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("runAcpPromotion", () => {
  test("dry-run validates requested agents and does not dispatch", async () => {
    const cfg = configFile();
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: false,
        agents: ["gemini-acp-pro"],
        baselines: ["gemini"],
        scenarios: ["ping_exact"],
        now: () => "2026-05-02T00:00:00.000Z",
      });

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        agent: "gemini-acp-pro",
        scenario: "ping_exact",
        status: "skipped",
      });
      expect(result.rows[1]).toMatchObject({
        agent: "gemini",
        scenario: "ping_exact",
        status: "skipped",
      });
    } finally {
      cfg.cleanup();
    }
  });

  test("live mode starts a chain and evaluates daemon evidence", async () => {
    const cfg = configFile();
    const calls: string[] = [];
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: true,
        agents: ["gemini-acp-pro"],
        baselines: [],
        scenarios: ["ping_exact"],
        now: () => "2026-05-02T00:00:00.000Z",
        pollIntervalMs: 1,
        client: {
          startChain() {
            calls.push("startChain");
            return Promise.resolve({ handoff_id: "h-live", conversation_id: "c-live" });
          },
          getHandoffStatus() {
            return Promise.resolve({
              handoff_id: "h-live",
              status: "completed",
              error_summary: null,
              worker_id: "w",
              started_at: "2026-05-02T00:00:00.000Z",
              resolved_at: "2026-05-02T00:00:05.000Z",
              latency_seconds: 5,
              reliability: {
                status: "complete",
                trustworthy: true,
                recommended_action: "accept",
                summary: "ok",
              },
            });
          },
          getChainResponses() {
            return Promise.resolve({
              responses: [
                {
                  agent: "gemini-acp-pro",
                  text: "ACP_PROMOTION_PING_OK\n",
                  ts: "2026-05-02T00:00:05.000Z",
                },
              ],
            });
          },
          getDispatchTimeline() {
            return Promise.resolve({
              events: [{ kind: "acp.session.start" }, { kind: "acp.session.end" }],
            });
          },
          dispatchAudit() {
            return Promise.resolve({
              report: { status: "complete", trustworthy: true, recommended_action: "accept" },
            });
          },
          inspectWorktree() {
            return Promise.resolve({
              worktree: { path: "/tmp/wt" },
              diff_against_main: "",
              branch_log: "",
            });
          },
        },
      });

      expect(calls).toEqual(["startChain"]);
      expect(result.rows[0]).toMatchObject({
        agent: "gemini-acp-pro",
        status: "passed",
        handoff_id: "h-live",
      });
    } finally {
      cfg.cleanup();
    }
  });

  test("live mode waits briefly for dispatch.end reliability after terminal status", async () => {
    const cfg = configFile();
    let statusCalls = 0;
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: true,
        agents: ["gemini-acp-pro"],
        baselines: [],
        scenarios: ["ping_exact"],
        now: () => "2026-05-02T00:00:00.000Z",
        pollIntervalMs: 1,
        client: {
          startChain() {
            return Promise.resolve({ handoff_id: "h-flush", conversation_id: "c-flush" });
          },
          getHandoffStatus() {
            statusCalls++;
            return Promise.resolve({
              handoff_id: "h-flush",
              status: "completed",
              error_summary: null,
              worker_id: "w",
              started_at: "2026-05-02T00:00:00.000Z",
              resolved_at: "2026-05-02T00:00:05.000Z",
              latency_seconds: 5,
              reliability:
                statusCalls === 1
                  ? {
                      status: "missing_dispatch_end",
                      trustworthy: false,
                      recommended_action: "review_manually",
                      summary: "not flushed yet",
                    }
                  : {
                      status: "complete",
                      trustworthy: true,
                      recommended_action: "accept",
                      summary: "ok",
                    },
            });
          },
          getChainResponses() {
            return Promise.resolve({
              responses: [{ agent: "gemini-acp-pro", text: "ACP_PROMOTION_PING_OK", ts: "t" }],
            });
          },
          getDispatchTimeline() {
            return Promise.resolve({ events: [{ kind: "dispatch.end" }] });
          },
          dispatchAudit() {
            return Promise.resolve({
              report: { status: "complete", trustworthy: true, recommended_action: "accept" },
            });
          },
          inspectWorktree() {
            return Promise.resolve({
              worktree: { path: "/tmp/wt" },
              diff_against_main: "",
              branch_log: "",
            });
          },
        },
      });

      expect(statusCalls).toBeGreaterThanOrEqual(2);
      expect(result.rows[0]).toMatchObject({ status: "passed", reliability_status: "complete" });
    } finally {
      cfg.cleanup();
    }
  });

  test("live mode verifies write_worktree_file artifact through worktree grep", async () => {
    const cfg = configFile();
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: true,
        agents: ["gemini-acp-pro"],
        baselines: [],
        scenarios: ["write_worktree_file"],
        now: () => "2026-05-02T00:00:00.000Z",
        pollIntervalMs: 1,
        client: {
          startChain() {
            return Promise.resolve({ handoff_id: "h-write", conversation_id: "c-write" });
          },
          getHandoffStatus() {
            return Promise.resolve({
              handoff_id: "h-write",
              status: "completed",
              error_summary: null,
              worker_id: "w",
              started_at: null,
              resolved_at: null,
              latency_seconds: 7,
              reliability: {
                status: "complete",
                trustworthy: true,
                recommended_action: "accept",
                summary: "ok",
              },
            });
          },
          getChainResponses() {
            return Promise.resolve({
              responses: [{ agent: "gemini-acp-pro", text: "ACP_PROMOTION_WRITE_DONE", ts: "t" }],
            });
          },
          getDispatchTimeline() {
            return Promise.resolve({ events: [] });
          },
          dispatchAudit() {
            return Promise.resolve({
              report: { status: "complete", trustworthy: true, recommended_action: "accept" },
            });
          },
          inspectWorktree() {
            return Promise.resolve({
              worktree: { path: "/tmp/wt" },
              diff_against_main: "diff --git a/acp-promotion-smoke.txt b/acp-promotion-smoke.txt",
              branch_log: "",
            });
          },
          grepInWorktree() {
            return Promise.resolve({
              results: [{ path: "acp-promotion-smoke.txt", line: 1, text: "ACP_WRITE_OK" }],
              truncated: false,
            });
          },
        },
      });

      expect(result.rows[0]).toMatchObject({
        status: "passed",
        artifact_verified: true,
        expected_artifact: "acp-promotion-smoke.txt",
      });
    } finally {
      cfg.cleanup();
    }
  });

  test("live mode records artifact verification failure instead of throwing when grep is unavailable", async () => {
    const cfg = configFile();
    try {
      const result = await runAcpPromotion({
        configPath: cfg.path,
        live: true,
        agents: ["gemini-acp-pro"],
        baselines: [],
        scenarios: ["write_worktree_file"],
        now: () => "2026-05-02T00:00:00.000Z",
        pollIntervalMs: 1,
        client: {
          startChain() {
            return Promise.resolve({
              handoff_id: "h-grep-missing",
              conversation_id: "c-grep-missing",
            });
          },
          getHandoffStatus() {
            return Promise.resolve({
              handoff_id: "h-grep-missing",
              status: "failed",
              error_summary: "cancelled",
              worker_id: "w",
              started_at: null,
              resolved_at: null,
              latency_seconds: 300,
              reliability: {
                status: "non_terminal_stale",
                trustworthy: false,
                recommended_action: "inspect_worktree",
                summary: "stale",
              },
            });
          },
          getChainResponses() {
            return Promise.resolve({ responses: [] });
          },
          getDispatchTimeline() {
            return Promise.resolve({ events: [] });
          },
          dispatchAudit() {
            return Promise.resolve({
              report: {
                status: "non_terminal_stale",
                trustworthy: false,
                recommended_action: "inspect_worktree",
              },
            });
          },
          inspectWorktree() {
            return Promise.resolve({ worktree: null, diff_against_main: "", branch_log: "" });
          },
          grepInWorktree() {
            throw new Error("worktree not found");
          },
        },
      });

      expect(result.rows[0]).toMatchObject({
        status: "failed",
        artifact_verified: false,
      });
      expect(result.rows.at(0)?.failure_reason).toMatch(
        /untrusted reliability status|artifact mismatch/,
      );
    } finally {
      cfg.cleanup();
    }
  });
});
