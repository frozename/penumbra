import type { WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { Database } from "bun:sqlite";
import { join } from "node:path";

// dispatch-drift-guard
//
// A UNIFORM drift backstop. Fires on every substantive solo tool-call
// (Edit/Write/MultiEdit/NotebookEdit/Bash), counts the TRAILING run of consecutive solo
// implementation tool-calls on the maestro loop since the last REAL dispatch, and once
// the streak crosses one threshold injects a post-tool-use session-reminder nudging
// maestro to dispatch the remaining work-list.
//
// It deliberately does NOT detect ultracode. Per-turn ultracode state is unknowable
// from the daemon process: the toggle is ephemeral CC session state (never written to
// settings.json — proven: settings mtime can predate an all-session-ultracode run), and
// no hook payload / session-state file / stable transcript marker carries it. The model
// is the only party that both KNOWS ultracode (it sees the per-turn reminder) and
// FOLLOWS instructions — so the "under ultracode, workflow-first for EVERY substantive
// task" escalation lives in the GLOBAL instruction (~/.claude/CLAUDE.md
// dispatch-discipline block + the maestro-context-prime bootstrap), which the model
// applies based on the ultracode state it observes. This guard is the uniform safety
// net for when the model drifts regardless; its reminder restates the ultracode
// conditional so the model re-applies it.
//
// Trip-condition is objective: it reads the maestro session's own agent-tool-use rows
// from t0_events (written by the PreToolUse hook), so it cannot be gamed by editing in
// a way the hook doesn't see. MCP fs tools count as solo. Only a real dispatch
// (chain_start / workflow_run / Task / Skill) resets the streak; a status poll
// (chain_status / chain_wait / workflow_status) does not. The guard reads NO transcript.
//
// Best-effort by construction: any db error returns "" so the hook never breaks Claude
// Code. PENUMBRA_SOLO_DRIFT_THRESHOLD / _RENAG tune it; PENUMBRA_DISPATCH_DRIFT_ENABLED=0
// disables it.

const DEFAULT_THRESHOLD = 8;
const DEFAULT_RENAG = 4;
// Cap how many recent tool rows we inspect for the trailing streak.
const SCAN_LIMIT = 200;

// Solo implementation tools — each one INCREMENTS the streak. Includes the CC built-ins
// AND the penumbra MCP fs/shell tools, else the streak is trivially evaded by routing
// edits through the MCP surface.
const SOLO_TOOLS = new Set<string>([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "mcp__penumbra__fs_edit",
  "mcp__penumbra__fs_write",
  "mcp__penumbra__shell_run",
  "mcp__penumbra__fs_exec",
]);

// Real-dispatch tools — each one RESETS the streak to 0. A bare chain_start, a
// workflow_run, a CC Workflow / Agent / Task / Skill dispatch, or an MCP dispatch
// all count.
const DISPATCH_TOOLS = new Set<string>([
  "Task",
  "Skill",
  "Workflow",
  "Agent",
  "mcp__penumbra__chain_start",
  "mcp__penumbra__chain_start_refined",
  "mcp__penumbra__chain_start_simple",
  "mcp__penumbra__workflow_run",
  "mcp__penumbra__plan_start",
  "mcp__penumbra__brainstorm",
]);

type Args = {
  db?: Database;
  session_id?: string;
};

type ToolRow = { tool: string | null; command: string | null; source_detail: string | null };

const spec: WorkflowSpec = {
  name: "dispatch-drift-guard",
  description:
    "After N consecutive solo implementation tool-calls on the maestro loop with no fleet dispatch in between, inject a post-tool-use reminder to dispatch the remaining work-list. Uniform threshold; the ultracode-conditional (apply it harder under ultracode) lives in the global instruction the model follows.",
  triggers: [
    {
      kind: "lifecycle",
      event: "post-tool-use",
      filter: { tool_name: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] },
    },
  ],
  recall: [],
  output: [{ kind: "session-reminder" }],
  run: { kind: "ts-function" },
};

function resolveDb(ctx: { db?: () => Database; args?: Args; storageRoot: string }): {
  db: Database;
  shouldClose: boolean;
} {
  if (ctx.db) return { db: ctx.db(), shouldClose: false };
  if (ctx.args?.db) return { db: ctx.args.db, shouldClose: false };
  return {
    db: new Database(join(ctx.storageRoot, "db.sqlite"), { readonly: true }),
    shouldClose: true,
  };
}

function resolveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// The tool name lives in payload_json.tool (preferred) with source_detail='tool:NAME'
// as a fallback for older rows.
function toolNameOf(row: ToolRow): string | null {
  if (typeof row.tool === "string" && row.tool.length > 0) return row.tool;
  if (typeof row.source_detail === "string" && row.source_detail.startsWith("tool:")) {
    return row.source_detail.slice("tool:".length);
  }
  return null;
}

// Shell-execution tools whose payload carries an `input.command` string. A read-only
// command on any of these must not increment the streak, or the guard is evaded by
// routing reads through the MCP shell surface.
function isShellRunner(name: string): boolean {
  return (
    name === "Bash" || name === "mcp__penumbra__shell_run" || name === "mcp__penumbra__fs_exec"
  );
}

// Return true if this shell command should count as a solo implementation step.
// Bias toward true (count it) when we cannot tell whether it writes, because
// under-counting drift is the failure mode this guard exists to prevent;
// over-counting is merely noise.
function bashCommandLooksWritey(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return true;

  // Any output redirection to a file means the call writes.
  // Strip quoted strings first so a > inside a string literal is not mistaken.
  const withoutStrings = trimmed.replaceAll(/(["'])(?:\\.|(?!\1).)*\1/g, "");
  if (/(?:\s>{1,2}\s+\S|\S>{1,2}[^&\s=>])/.test(withoutStrings)) return true;

  // Multi-stage chains and backgrounding are hard to classify. Split on the first
  // stage and inspect it; if we still cannot tell, fall through to the conservative
  // default.
  const firstStage = (trimmed.split(/[|&;]+/)[0] ?? "").trim();
  const parts = firstStage.split(/\s+/);
  const bin = parts[0] ?? "";
  const sub = parts[1] ?? "";

  switch (bin) {
    case "git": {
      const readOnly = new Set(["log", "show", "diff", "status", "rev-parse"]);
      return !readOnly.has(sub);
    }
    case "sed": {
      // sed without -i / --in-place only writes to stdout; -i mutates files in place.
      return /\s(-i|--in-place)\b/.test(trimmed);
    }
    case "sqlite3": {
      const rest = firstStage.slice(firstStage.indexOf(" ") + 1).toUpperCase();
      return /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|ATTACH|PRAGMA\s+WRITE|VACUUM)\b/.test(rest);
    }
    case "python3":
    case "python": {
      const rest = firstStage.slice(bin.length).toUpperCase();
      return (
        /\bOPEN\s*\([^)]*['"]W/.test(rest) ||
        /\.WRITE\s*\(/.test(rest) ||
        /\bJSON\.DUMP/.test(rest) ||
        />\s*\S/.test(rest)
      );
    }
    case "curl": {
      // -o/-O writes a file; -d/--data / -X are write side-effects to the remote.
      return /\s(-[oO]|--output|--upload-file|--data|-d|--request|-X)\b/.test(trimmed);
    }
    default: {
      // Unknown shell command: fall through to the read-only list or the conservative
      // default at the end of the function.
    }
  }

  const readOnlyBins = new Set([
    "grep",
    "rg",
    "cat",
    "head",
    "tail",
    "ls",
    "find",
    "wc",
    "jq",
    "awk",
    "xargs",
    "sort",
    "uniq",
    "cut",
    "tr",
    "dirname",
    "basename",
    "readlink",
    "which",
    "file",
    "stat",
    "md5sum",
    "sha256sum",
    "date",
    "whoami",
    "pwd",
    "uname",
    "hostname",
    "id",
    "groups",
    "env",
    "printenv",
    "tput",
  ]);
  if (readOnlyBins.has(bin)) return false;

  // Unknown / multi-command / assignment / control flow: count it.
  return true;
}

// Count the trailing run of consecutive SOLO tool-calls, stopping (resetting) at the
// first real dispatch. Reads/greps and status polls are skipped (neither increment nor
// reset). rows are newest-first.
function countTrailingSoloStreak(rows: ToolRow[]): number {
  let streak = 0;
  for (const row of rows) {
    const name = toolNameOf(row);
    if (!name) continue;
    if (DISPATCH_TOOLS.has(name)) break; // real dispatch resets the streak
    if (SOLO_TOOLS.has(name)) {
      if (isShellRunner(name) && !bashCommandLooksWritey(row.command ?? "")) {
        continue; // read-only shell call is inert
      }
      streak += 1;
    }
    // anything else (reads, greps, status polls, other MCP reads) is inert
  }
  return streak;
}

function render(streak: number, threshold: number): string {
  return [
    "<system-reminder>",
    `dispatch-drift: ${streak} consecutive solo implementation tool-calls on the main loop with no fleet dispatch in between (threshold ${threshold}).`,
    "Dispatch the remaining work-list via `workflow_run` / a CC Workflow (penumbra-fanout, penumbra-fix-until-green, penumbra-fleet-verify, penumbra-swarm) rather than hand-implementing solo. Serial diagnosis is exempt — but the fix-list it produces is dispatchable.",
    "If ultracode is ON, treat this as binding: workflow-first for EVERY substantive task, token cost is not a constraint. If this work is genuinely solo (single trivial edit, a daemon-won't-boot fix, or scaffolding an agent will build on), note `SOLO-OK: <reason>` and continue.",
    "</system-reminder>",
  ].join("\n");
}

export const fn: WorkflowFn<Args> = async (ctx) => {
  if (process.env.PENUMBRA_DISPATCH_DRIFT_ENABLED === "0") return "";

  const sessionId = ctx.args?.session_id;
  // Only nag the maestro loop. Absent session_id, or a dispatch-worker session
  // (conv-* prefix), stays silent. UUID-shaped session_id => maestro.
  if (!sessionId) return "";
  if (sessionId.startsWith("conv-")) return "";
  if (!/^[0-9a-f]{8}-/i.test(sessionId)) return "";

  const threshold = resolveIntEnv("PENUMBRA_SOLO_DRIFT_THRESHOLD", DEFAULT_THRESHOLD);
  const renagEvery = resolveIntEnv("PENUMBRA_SOLO_DRIFT_RENAG", DEFAULT_RENAG);

  let streak = 0;
  try {
    // resolveDb is inside the try so a db-open failure returns "" rather than throwing —
    // the guard must never break Claude Code (best-effort invariant).
    const { db, shouldClose } = resolveDb(ctx);
    try {
      // session_id-keyed: seeks by (session_id, event_type) via t0_by_session_type_ts
      // rather than scanning every agent-tool-use row via t0_by_type_ts. project_id is
      // NOT a usable filter here — one session scatters across many synthetic project_ids
      // (per-subdirectory relpath suffix).
      const rows = db
        .query<ToolRow, [string, number]>(
          `SELECT json_extract(payload_json, '$.tool') AS tool,
                  json_extract(payload_json, '$.input.command') AS command,
                  source_detail
             FROM t0_events
            WHERE session_id = ?
              AND source = 'claude-code'
              AND event_type = 'agent-tool-use'
            ORDER BY ts DESC, rowid DESC
            LIMIT ?`,
        )
        .all(sessionId, SCAN_LIMIT);
      streak = countTrailingSoloStreak(rows);
    } finally {
      if (shouldClose) {
        try {
          db.close();
        } catch {}
      }
    }
  } catch {
    return "";
  }

  if (streak < threshold) return "";

  // Re-nag cadence: fire AT the threshold, then only every `renagEvery` calls past it, so
  // we don't spam a reminder on every subsequent solo call.
  const over = streak - threshold;
  if (over % renagEvery !== 0) return "";

  return render(streak, threshold);
};

export default spec;
