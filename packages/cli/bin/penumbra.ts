#!/usr/bin/env bun
import {
  type AgentOutcome,
  type AgentSmokePass,
  type AgentTaskType,
  Branding,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { runChainSendMessage } from "../src/commands/chain.js";
import { runConsole } from "../src/commands/console.js";
import { runDispatchAudit } from "../src/commands/dispatch-audit.js";
import {
  runDispatchLand,
  runDispatchListPending,
  runDispatchTimeline,
} from "../src/commands/dispatch.js";
import { runExport } from "../src/commands/export.js";
import { runHook } from "../src/commands/hook.js";
import { runImport } from "../src/commands/import.js";
import { runInit } from "../src/commands/init.js";
import { dispatchLongLivedSubcommand } from "../src/commands/long-lived.js";
import { dispatchMaestroSubcommand } from "../src/commands/maestro.js";
import { runMemoryDigest, runMemoryImport } from "../src/commands/memory.js";
import { runNotesRotate } from "../src/commands/notes-rotate.js";
import { dispatchPlanSubcommand } from "../src/commands/plan.js";
import { runRecallBackfill } from "../src/commands/recall-backfill.js";
import { runRecall } from "../src/commands/recall.js";
import { runRecent } from "../src/commands/recent.js";
import { dispatchRegistrarSubcommand } from "../src/commands/registrar.js";
import { runRepair } from "../src/commands/repair.js";
import { runStart, runStartDetached } from "../src/commands/start.js";
import { runStatus } from "../src/commands/status.js";
import { runStop } from "../src/commands/stop.js";
import { runTail } from "../src/commands/tail.js";
import {
  runTaskCancel,
  runTaskList,
  runTaskNew,
  runTaskReview,
  runTaskShow,
  runTaskWatch,
} from "../src/commands/task.js";
import { runWatchdog } from "../src/commands/watchdog.js";
import { dispatchWorkflowSubcommand } from "../src/commands/workflow.js";
import { resolveCliStorageRoot } from "../src/storage-root.js";

// Bootstrap the homebrew-supplied sqlite for sqlite-vec on macOS.
// Must run before any `new Database(...)` call. Idempotent.
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded or not available */
}

const cmd = process.argv[2];
const bootstrapRoot = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;

function resolveLiveRoot(): string {
  try {
    return resolveCliStorageRoot();
  } catch {
    return bootstrapRoot;
  }
}

switch (cmd) {
  case "init":
    process.exit(
      await runInit({
        storageRoot: bootstrapRoot,
        forceAgentchat:
          process.argv.includes("--force-agentchat") || process.argv.includes("--reset-agentchat"),
      }),
    );
    break;
  case "start":
    {
      const detach = process.argv.includes("--detach") || process.argv.includes("-d");
      const host = readOptionalFlagValue("--host");
      const portRaw = readOptionalFlagValue("--port");
      let port: number | undefined;
      if (portRaw !== undefined) {
        const parsed = Number(portRaw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          console.error(
            `penumbra start: --port must be an integer in [0, 65535] (got: ${portRaw})`,
          );
          process.exit(2);
        }
        port = parsed;
      }
      const displayHost = formatHostForUrl(host ?? process.env.PENUMBRA_DAEMON_HOST ?? "127.0.0.1");
      if (detach) {
        try {
          const r = await runStartDetached({ storageRoot: bootstrapRoot, host, port });
          emit(
            `penumbra: detached on http://${displayHost}:${String(r.port)} (pid=${String(r.pid)}); logs at ${r.logPath}`,
          );
          process.exit(0);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }
      }
      const handle = await runStart({ storageRoot: bootstrapRoot, host, port });
      let stopping = false;
      const onSignal = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        await runStop({ storageRoot: bootstrapRoot, handle });
        process.exit(0);
      };
      const signalHandler = (): void => {
        void onSignal();
      };
      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
      emit(
        `penumbra: running on http://${displayHost}:${String(handle.port)} (pid=${String(process.pid)}). Ctrl-C to stop.`,
      );
      await new Promise<never>(() => undefined); // block forever; signals drive exit
      process.exit(0);
    }
    break;
  case "stop":
    process.exit(await runStop({ storageRoot: resolveLiveRoot() }));
    break;
  case "status":
    {
      const s = await runStatus({ storageRoot: resolveLiveRoot() });
      emit(JSON.stringify(s, null, 2));
      process.exit(s.status === "running" ? 0 : 2);
    }
    break;
  case "watchdog":
    {
      try {
        const result = await runWatchdog({
          storageRoot: resolveLiveRoot(),
          heal: process.argv.includes("--heal"),
        });
        emit(JSON.stringify(result));
        process.exit(result.status === "healthy" ? 0 : 2);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "export":
    {
      const outPath = process.argv[3] ?? join(bootstrapRoot, "export.jsonl");
      const projectFlagIdx = process.argv.indexOf("--project");
      const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
      const dbPath = join(bootstrapRoot, "db.sqlite");
      process.exit(await runExport({ dbPath, project, outPath }));
    }
    break;
  case "import":
    {
      const inPath = process.argv[3];
      if (!inPath) {
        console.error("usage: penumbra import <file.jsonl>");
        process.exit(1);
      }
      const dbPath = join(bootstrapRoot, "db.sqlite");
      process.exit(await runImport({ dbPath, inPath }));
    }
    break;
  case "repair":
    {
      const r = await runRepair({ storageRoot: resolveLiveRoot() });
      emit(JSON.stringify(r, null, 2));
      process.exit(r.outcome === "failed" ? 2 : 0);
    }
    break;
  case "recall-backfill":
    {
      process.exit(await runRecallBackfill({ storageRoot: resolveLiveRoot() }));
    }
    break;
  case "tail":
    {
      const projectFlagIdx = process.argv.indexOf("--project");
      const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
      const limitFlagIdx = process.argv.indexOf("--limit");
      const limit = limitFlagIdx >= 0 ? Number(process.argv[limitFlagIdx + 1]) : 20;
      if (!Number.isInteger(limit) || limit < 1) {
        console.error("penumbra tail: --limit must be a positive integer");
        process.exit(1);
      }
      const dbPath = join(bootstrapRoot, "db.sqlite");
      const rows = runTail({ dbPath, project, limit });
      emit(JSON.stringify(rows, null, 2));
      process.exit(0);
    }
    break;
  case "recent":
    {
      const projectFlagIdx = process.argv.indexOf("--project");
      const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
      const limitFlagIdx = process.argv.indexOf("--limit");
      const limit = limitFlagIdx >= 0 ? Number(process.argv[limitFlagIdx + 1]) : 10;
      if (!Number.isInteger(limit) || limit < 1) {
        console.error("penumbra recent: --limit must be a positive integer");
        process.exit(1);
      }
      const dbPath = join(bootstrapRoot, "db.sqlite");
      const rows = runRecent({ dbPath, project, limit });
      emit(JSON.stringify(rows, null, 2));
      process.exit(0);
    }
    break;
  case "memory":
    {
      const sub = process.argv[3];
      if (sub === "digest") {
        const maestro = process.argv.includes("--maestro");
        const limitRaw = readOptionalFlagValue("--limit");
        const limit = limitRaw === undefined ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          console.error("penumbra memory digest: --limit must be a positive integer");
          process.exit(1);
        }
        process.exit(
          runMemoryDigest({
            storageRoot: resolveLiveRoot(),
            maestro,
            limit,
          }),
        );
      }

      if (sub === "import-from-claude-code") {
        const root = readOptionalFlagValue("--root");
        if (!root) {
          console.error(
            "usage: penumbra memory import-from-claude-code --root <path> (--dry-run | --apply)",
          );
          process.exit(1);
        }
        const dryRun = process.argv.includes("--dry-run");
        const apply = process.argv.includes("--apply");
        if (!dryRun && !apply) {
          console.error(
            "usage: penumbra memory import-from-claude-code --root <path> (--dry-run | --apply)",
          );
          process.exit(1);
        }
        if (dryRun && apply) {
          console.error("cannot combine --dry-run and --apply");
          process.exit(1);
        }

        const result = await runMemoryImport({
          root,
          dryRun,
          apply,
          storageRoot: resolveLiveRoot(),
        });
        if (result.error === "root_not_found") {
          console.error("penumbra memory import-from-claude-code: root_not_found");
          process.exit(1);
        }

        if (apply) {
          emit(
            `Imported: ${String(result.imported)} updated: ${String(result.updated)} skipped: ${String(result.skipped)} errors: ${String(result.errors)}`,
          );
          process.exit(result.errors > 0 ? 1 : 0);
        } else {
          emit(
            `Would write: ${String(result.would_write)} skipped: ${String(result.skipped)} errors: ${String(result.errors)}`,
          );
          process.exit(0);
        }
      }

      console.error("usage: penumbra memory digest [--maestro] [--limit N]");
      process.exit(1);
    }
    break;
  case "hooks":
    {
      const sub = process.argv[3];
      const forceReplace = process.argv.includes("--force-replace");
      const claudeFlag = process.argv.includes("--claude");
      const geminiOtelFlag = process.argv.includes("--gemini-otel");
      const codexOtelFlag = process.argv.includes("--codex-otel");
      const claudeOtelFlag = process.argv.includes("--claude-otel");
      const claudeMemoryFlag = process.argv.includes("--claude-memory");
      const claudeMdFlag = process.argv.includes("--claude-md");
      try {
        const {
          runHooksInstallClaude,
          runHooksUninstallClaude,
          runHooksStatus,
          runHooksInstallGeminiOtel,
          runHooksUninstallGeminiOtel,
          runHooksInstallCodexOtel,
          runHooksUninstallCodexOtel,
          runHooksInstallClaudeOtel,
          runHooksUninstallClaudeOtel,
          runHooksInstallClaudeMemory,
          runHooksUninstallClaudeMemory,
          runHooksInstallClaudeMd,
          runHooksUninstallClaudeMd,
        } = await import("../src/commands/hooks.js");
        if (sub === "install") {
          if (claudeMdFlag) {
            const r = await runHooksInstallClaudeMd();
            emit(
              r.idempotent
                ? `penumbra hooks: dispatch-discipline CLAUDE.md block already current (${r.path})`
                : `penumbra hooks: installed dispatch-discipline CLAUDE.md block → ${r.path}`,
            );
            process.exit(0);
          }
          if (claudeMemoryFlag) {
            const r = await runHooksInstallClaudeMemory();
            if (r.idempotent) {
              emit(`penumbra hooks: claude memory hooks already current (${r.events.join(", ")})`);
            } else {
              emit(`penumbra hooks: installed claude memory hooks for ${r.events.join(", ")}`);
              emit(`penumbra hooks:   storage_root=${r.storageRoot}`);
            }
            process.exit(0);
          }
          if (claudeOtelFlag) {
            const r = await runHooksInstallClaudeOtel();
            emit(
              r.idempotent
                ? `penumbra hooks: claude OTel already configured (${r.endpoint})`
                : `penumbra hooks: claude OTel installed → ${r.endpoint}`,
            );
            process.exit(0);
          }
          if (codexOtelFlag) {
            const r = await runHooksInstallCodexOtel();
            emit(
              r.idempotent
                ? `penumbra hooks: codex OTel already configured (${r.endpoint})`
                : `penumbra hooks: codex OTel installed → ${r.endpoint}`,
            );
            process.exit(0);
          }
          if (geminiOtelFlag) {
            const r = await runHooksInstallGeminiOtel();
            emit(
              r.idempotent
                ? `penumbra hooks: gemini OTel already configured (${r.endpoint})`
                : `penumbra hooks: gemini OTel installed → ${r.endpoint}`,
            );
            process.exit(0);
          }
          if (!claudeFlag) {
            console.error(
              "usage: penumbra hooks install (--claude [--force-replace] | --claude-memory | --claude-md | --claude-otel | --gemini-otel | --codex-otel)",
            );
            process.exit(1);
          }
          const r = await runHooksInstallClaude({ force: forceReplace });
          emit(
            r.idempotent
              ? "penumbra hooks: already installed"
              : `penumbra hooks: installed statusline at ${r.scriptPath}`,
          );
          if (r.backupPath) emit(`penumbra hooks: backed up previous settings to ${r.backupPath}`);
          process.exit(0);
        }
        if (sub === "uninstall") {
          if (claudeMdFlag) {
            const r = await runHooksUninstallClaudeMd();
            emit(
              r.removed
                ? "penumbra hooks: removed dispatch-discipline CLAUDE.md block"
                : "penumbra hooks: no dispatch-discipline CLAUDE.md block found",
            );
            process.exit(0);
          }
          if (claudeMemoryFlag) {
            const r = await runHooksUninstallClaudeMemory();
            emit(
              r.removed
                ? `penumbra hooks: removed claude memory hooks from ${r.events.join(", ")}`
                : "penumbra hooks: no claude memory hooks found",
            );
            process.exit(0);
          }
          if (claudeOtelFlag) {
            const r = await runHooksUninstallClaudeOtel();
            emit(
              r.removed
                ? "penumbra hooks: removed claude OTel telemetry env vars"
                : "penumbra hooks: no claude OTel telemetry env vars found",
            );
            process.exit(0);
          }
          if (codexOtelFlag) {
            const r = await runHooksUninstallCodexOtel();
            emit(
              r.removed
                ? "penumbra hooks: removed codex OTel telemetry block"
                : "penumbra hooks: no codex OTel telemetry block found",
            );
            process.exit(0);
          }
          if (geminiOtelFlag) {
            const r = await runHooksUninstallGeminiOtel();
            emit(
              r.removed
                ? "penumbra hooks: removed gemini OTel telemetry block"
                : "penumbra hooks: no gemini OTel telemetry block found",
            );
            process.exit(0);
          }
          if (!claudeFlag) {
            console.error(
              "usage: penumbra hooks uninstall (--claude | --claude-memory | --claude-md | --claude-otel | --gemini-otel | --codex-otel)",
            );
            process.exit(1);
          }
          const r = await runHooksUninstallClaude();
          emit(
            r.removed
              ? "penumbra hooks: removed statusLine from settings.json"
              : "penumbra hooks: no penumbra statusLine found",
          );
          process.exit(0);
        }
        if (sub === "status") {
          await runHooksStatus();
          process.exit(0);
        }
        console.error(
          "usage: penumbra hooks <install|uninstall|status> (--claude [--force-replace] | --claude-memory | --claude-md | --claude-otel | --gemini-otel | --codex-otel)",
        );
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "cost":
    {
      const sub = process.argv[3];
      const since = readOptionalFlagValue("--since");
      const projectId = readOptionalFlagValue("--project-id");
      const json = process.argv.includes("--json");
      try {
        const { runCostRecent, runCostQuota } = await import("../src/commands/cost.js");
        if (sub === "recent") {
          await runCostRecent({
            since,
            project_id: projectId ?? null,
            json,
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "quota") {
          await runCostQuota({
            since,
            json,
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        console.error(
          "usage: penumbra cost <recent|quota> [--since <duration>] [--project-id <id>] [--json]",
        );
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "agent":
    {
      const sub = process.argv[3];
      const usage = [
        "usage:",
        "  penumbra agent rank --task-type <type> [--since <iso>] [--min-samples <n>] [--include-neutral] [--include-cost] [--json]",
        "  penumbra agent ledger add --handoff-id <id> --task-type <type> --outcome <outcome> [--rounds <n>] [--smoke-pass y|n|partial|n/a] [--reviewer-findings <n>] [--maestro-score <1-5>] [--cost-usd <n>] [--notes <text>] [--json]",
        "  penumbra agent ledger import --from <markdown>",
        "  penumbra agent ledger render [--out <markdown>]",
      ].join("\n");
      const { runAgentLedgerAdd, runAgentLedgerImport, runAgentLedgerRender, runAgentRank } =
        await import("../src/commands/agent.js");
      try {
        if (sub === "rank") {
          const taskType = readOptionalFlagValue("--task-type");
          if (!taskType) {
            console.error(usage);
            process.exit(1);
          }
          const since = readOptionalFlagValue("--since");
          const minSamplesRaw = readOptionalFlagValue("--min-samples");
          const min_samples = minSamplesRaw === undefined ? undefined : Number(minSamplesRaw);
          if (min_samples !== undefined && (!Number.isInteger(min_samples) || min_samples < 1)) {
            console.error("penumbra agent rank: --min-samples must be a positive integer");
            process.exit(1);
          }
          const json = process.argv.includes("--json");
          const include_neutral = process.argv.includes("--include-neutral");
          const include_cost = process.argv.includes("--include-cost");
          await runAgentRank({
            task_type: taskType,
            since,
            min_samples,
            include_neutral,
            include_cost,
            json,
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }

        if (sub === "ledger") {
          const action = process.argv[4];
          if (action === "add") {
            const handoff_id = readOptionalFlagValue("--handoff-id");
            const task_type = readOptionalFlagValue("--task-type");
            const outcome = readOptionalFlagValue("--outcome");
            if (!handoff_id || !task_type || !outcome) {
              console.error(usage);
              process.exit(1);
            }

            const roundsRaw = readOptionalFlagValue("--rounds");
            const reviewerFindingsRaw = readOptionalFlagValue("--reviewer-findings");
            const maestroScoreRaw = readOptionalFlagValue("--maestro-score");
            const costUsdRaw = readOptionalFlagValue("--cost-usd");
            const smoke_pass = readOptionalFlagValue("--smoke-pass");
            const notes = readOptionalFlagValue("--notes");
            const rounds = roundsRaw === undefined ? undefined : Number(roundsRaw);
            const reviewer_findings =
              reviewerFindingsRaw === undefined ? undefined : Number(reviewerFindingsRaw);
            const maestro_score =
              maestroScoreRaw === undefined ? undefined : Number(maestroScoreRaw);
            const cost_usd = costUsdRaw === undefined ? undefined : Number(costUsdRaw);
            if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 0)) {
              console.error("penumbra agent ledger add: --rounds must be a non-negative integer");
              process.exit(1);
            }
            if (smoke_pass !== undefined && !["y", "n", "partial", "n/a"].includes(smoke_pass)) {
              console.error(
                "penumbra agent ledger add: --smoke-pass must be one of y, n, partial, n/a",
              );
              process.exit(1);
            }
            if (
              reviewer_findings !== undefined &&
              (!Number.isInteger(reviewer_findings) || reviewer_findings < 0)
            ) {
              console.error(
                "penumbra agent ledger add: --reviewer-findings must be a non-negative integer",
              );
              process.exit(1);
            }
            if (
              maestro_score !== undefined &&
              (!Number.isInteger(maestro_score) || maestro_score < 1 || maestro_score > 5)
            ) {
              console.error(
                "penumbra agent ledger add: --maestro-score must be an integer in [1, 5]",
              );
              process.exit(1);
            }
            if (cost_usd !== undefined && (Number.isNaN(cost_usd) || cost_usd < 0)) {
              console.error("penumbra agent ledger add: --cost-usd must be a non-negative number");
              process.exit(1);
            }

            await runAgentLedgerAdd({
              handoff_id,
              task_type: task_type as AgentTaskType,
              outcome: outcome as AgentOutcome,
              rounds,
              smoke_pass: smoke_pass as AgentSmokePass | undefined,
              reviewer_findings,
              maestro_score,
              cost_usd,
              notes: notes ?? undefined,
              json: process.argv.includes("--json"),
              storageRoot: resolveLiveRoot(),
            });
            process.exit(0);
          }

          if (action === "import") {
            const from = readOptionalFlagValue("--from");
            if (!from) {
              console.error(usage);
              process.exit(1);
            }
            await runAgentLedgerImport({
              from,
              storageRoot: resolveLiveRoot(),
            });
            process.exit(0);
          }

          if (action === "render") {
            await runAgentLedgerRender({
              out: readOptionalFlagValue("--out") ?? undefined,
              storageRoot: resolveLiveRoot(),
            });
            process.exit(0);
          }
        }

        console.error(usage);
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "dispatch":
    {
      const sub = process.argv[3];
      try {
        if (sub === "timeline") {
          const handoffId = process.argv[4];
          if (!handoffId || handoffId.startsWith("-")) {
            console.error("usage: penumbra dispatch timeline <handoff_id> [--json]");
            process.exit(1);
          }
          await runDispatchTimeline({
            handoffId,
            json: process.argv.includes("--json"),
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "audit") {
          const handoffId = process.argv[4];
          if (!handoffId || handoffId.startsWith("-")) {
            console.error("usage: penumbra dispatch audit <handoff_id> [--json]");
            process.exit(1);
          }
          await runDispatchAudit({
            handoffId,
            json: process.argv.includes("--json"),
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "land") {
          const handoffId = process.argv[4];
          if (!handoffId || handoffId.startsWith("-")) {
            console.error(
              "usage: penumbra dispatch land <handoff_id> [--message <subject>] [--mode squash|ff] [--no-delete-branch] [--force]",
            );
            process.exit(1);
          }
          const modeRaw = readOptionalFlagValue("--mode");
          if (modeRaw !== undefined && modeRaw !== "squash" && modeRaw !== "ff") {
            console.error(`penumbra dispatch land: --mode must be squash or ff (got: ${modeRaw})`);
            process.exit(1);
          }
          await runDispatchLand({
            handoffId,
            message: readOptionalFlagValue("--message"),
            mode: modeRaw,
            deleteBranch: !process.argv.includes("--no-delete-branch"),
            force: process.argv.includes("--force"),
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "list-pending") {
          const limitRaw = readOptionalFlagValue("--limit");
          const limit = limitRaw === undefined ? undefined : Number(limitRaw);
          if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
            console.error(
              `penumbra dispatch list-pending: --limit must be a positive integer (got: ${limitRaw ?? ""})`,
            );
            process.exit(1);
          }
          await runDispatchListPending({
            storageRoot: resolveLiveRoot(),
            limit,
          });
          process.exit(0);
        }
        console.error("usage: penumbra dispatch <timeline|audit|land|list-pending> ...");
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "recall":
    {
      const query = process.argv[3];
      if (!query) {
        console.error(
          "usage: penumbra recall <query> [--project <id>] [--limit <n>] [--session <id>] [--event-types <types>] [--file <path>] [--include-raw]",
        );
        process.exit(1);
      }
      const projectFlagIdx = process.argv.indexOf("--project");
      const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
      const limitFlagIdx = process.argv.indexOf("--limit");
      const limit = limitFlagIdx >= 0 ? Number(process.argv[limitFlagIdx + 1]) : 5;
      if (!Number.isInteger(limit) || limit < 1) {
        console.error("penumbra recall: --limit must be a positive integer");
        process.exit(1);
      }
      const sessionFlagIdx = process.argv.indexOf("--session");
      const sessionId =
        sessionFlagIdx >= 0 ? (process.argv[sessionFlagIdx + 1] ?? undefined) : undefined;
      const eventTypesFlagIdx = process.argv.indexOf("--event-types");
      const eventTypesRaw =
        eventTypesFlagIdx >= 0 ? (process.argv[eventTypesFlagIdx + 1] ?? "") : "";
      const eventTypes = eventTypesRaw
        ? eventTypesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const fileFlagIdx = process.argv.indexOf("--file");
      const filePath = fileFlagIdx >= 0 ? (process.argv[fileFlagIdx + 1] ?? undefined) : undefined;
      const includeRaw = process.argv.includes("--include-raw");

      try {
        const hits = await runRecall({
          storageRoot: resolveLiveRoot(),
          query,
          project,
          limit,
          session_id: sessionId,
          event_types: eventTypes,
          file_path: filePath,
          include_raw: includeRaw,
        });
        emit(JSON.stringify(hits, null, 2));
        process.exit(0);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "hook":
    {
      // Reads a Claude Code hook event JSON from stdin and forwards a t0 observation.
      // Designed for use in ~/.claude/settings.json hooks (PreToolUse, PostToolUse,
      // UserPromptSubmit). Best-effort — never blocks the hook on observation failures.
      const subtype = process.argv[3];
      if (subtype !== "claude-code") {
        console.error("usage: penumbra hook claude-code [--project <id>] [--session <id>]");
        process.exit(1);
      }
      const projectFlagIdx = process.argv.indexOf("--project");
      const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
      const sessionFlagIdx = process.argv.indexOf("--session");
      const sessionId = sessionFlagIdx >= 0 ? (process.argv[sessionFlagIdx + 1] ?? null) : null;
      const rawEvent = await Bun.stdin.text();
      try {
        const root = resolveLiveRoot();
        process.exit(await runHook({ storageRoot: root, rawEvent, project, sessionId }));
      } catch {
        // hook is best-effort — never block the calling Claude Code hook on discovery.
        process.exit(0);
      }
    }
    break;
  case "workflow":
    {
      const rest = process.argv.slice(3);
      try {
        const code = await dispatchWorkflowSubcommand(rest, resolveLiveRoot());
        process.exit(code);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "plan":
    {
      const rest = process.argv.slice(3);
      try {
        const code = await dispatchPlanSubcommand(rest, resolveLiveRoot());
        process.exit(code);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "registrar":
    {
      try {
        const code = await dispatchRegistrarSubcommand(process.argv.slice(3), resolveLiveRoot());
        process.exit(code);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "maestro":
    {
      try {
        const code = await dispatchMaestroSubcommand(process.argv.slice(3), resolveLiveRoot());
        process.exit(code);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "task":
    {
      const sub = process.argv[3];
      try {
        if (sub === "new") {
          const prompt = readOptionalFlagValue("--prompt");
          const priority = readOptionalFlagValue("--priority") as
            | "low"
            | "normal"
            | "high"
            | "urgent"
            | undefined;
          const kind = readOptionalFlagValue("--kind");
          const requireTags = process.argv
            .flatMap((arg, idx) => (arg === "--require-tag" ? [process.argv[idx + 1]] : []))
            .filter((v): v is string => Boolean(v && !v.startsWith("-")));
          const minTier = readOptionalFlagValue("--min-tier");
          const acceptance = readOptionalFlagValue("--acceptance");
          const fromFile = readOptionalFlagValue("--from-file");
          const requireReview = process.argv.includes("--require-review");
          const allowAgents = process.argv
            .flatMap((arg, idx) => (arg === "--allow-agent" ? [process.argv[idx + 1]] : []))
            .filter((v): v is string => Boolean(v && !v.startsWith("-")));
          const ghRepo = readOptionalFlagValue("--gh");
          const ghTitle = readOptionalFlagValue("--gh-title");
          const ghBody = readOptionalFlagValue("--gh-body");
          const ghLabels = process.argv
            .flatMap((arg, idx) => (arg === "--gh-label" ? [process.argv[idx + 1]] : []))
            .filter((v): v is string => Boolean(v && !v.startsWith("-")));
          const ghAssignees = process.argv
            .flatMap((arg, idx) => (arg === "--gh-assignee" ? [process.argv[idx + 1]] : []))
            .filter((v): v is string => Boolean(v && !v.startsWith("-")));
          const boundsWallClockMinRaw = readOptionalFlagValue("--bounds-wall-clock-min");
          const boundsCostCentsRaw = readOptionalFlagValue("--bounds-cost-cents");
          const boundsSubDispatchesRaw = readOptionalFlagValue("--bounds-sub-dispatches");
          const boundsWallClockMin =
            boundsWallClockMinRaw === undefined ? undefined : Number(boundsWallClockMinRaw);
          const boundsCostCents =
            boundsCostCentsRaw === undefined ? undefined : Number(boundsCostCentsRaw);
          const boundsSubDispatches =
            boundsSubDispatchesRaw === undefined ? undefined : Number(boundsSubDispatchesRaw);
          if (
            boundsWallClockMin !== undefined &&
            (!Number.isInteger(boundsWallClockMin) || boundsWallClockMin < 1)
          ) {
            console.error(
              `penumbra task new: --bounds-wall-clock-min must be a positive integer (got: ${boundsWallClockMinRaw ?? ""})`,
            );
            process.exit(1);
          }
          if (
            boundsCostCents !== undefined &&
            (!Number.isInteger(boundsCostCents) || boundsCostCents < 0)
          ) {
            console.error(
              `penumbra task new: --bounds-cost-cents must be a non-negative integer (got: ${boundsCostCentsRaw ?? ""})`,
            );
            process.exit(1);
          }
          if (
            boundsSubDispatches !== undefined &&
            (!Number.isInteger(boundsSubDispatches) || boundsSubDispatches < 1)
          ) {
            console.error(
              `penumbra task new: --bounds-sub-dispatches must be a positive integer (got: ${boundsSubDispatchesRaw ?? ""})`,
            );
            process.exit(1);
          }
          if (kind === "orchestrate" && allowAgents.length === 0) {
            console.error(
              "penumbra task new: kind=orchestrate requires at least one --allow-agent",
            );
            process.exit(1);
          }
          if (!prompt && !fromFile) {
            console.error(
              "usage: penumbra task new [--prompt <text>] [--priority low|normal|high|urgent] [--kind <kind>] [--require-tag <tag>]... [--min-tier <tier>] [--require-review] [--acceptance <text>] [--allow-agent <name>]... [--bounds-wall-clock-min <int>] [--bounds-cost-cents <int>] [--bounds-sub-dispatches <int>] [--gh <owner/repo>] [--gh-title <text>] [--gh-body <text>] [--gh-label <label>]... [--gh-assignee <login>]... [--from-file <path>]",
            );
            process.exit(1);
          }
          await runTaskNew({
            prompt: prompt ?? undefined,
            priority,
            kind: kind ?? undefined,
            require_tags: requireTags,
            min_tier: minTier,
            require_review: requireReview,
            acceptance,
            allow_agents: allowAgents,
            bounds_wall_clock_min: Number.isFinite(boundsWallClockMin)
              ? boundsWallClockMin
              : undefined,
            bounds_cost_cents: Number.isFinite(boundsCostCents) ? boundsCostCents : undefined,
            bounds_sub_dispatches: Number.isFinite(boundsSubDispatches)
              ? boundsSubDispatches
              : undefined,
            gh_repo: ghRepo ?? undefined,
            gh_title: ghTitle ?? undefined,
            gh_body: ghBody ?? undefined,
            gh_labels: ghLabels,
            gh_assignees: ghAssignees,
            from_file: fromFile,
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "list") {
          await runTaskList({
            status: readOptionalFlagValue("--status") ?? undefined,
            kind: readOptionalFlagValue("--kind") ?? undefined,
            mine: process.argv.includes("--mine"),
            json: process.argv.includes("--json"),
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "show") {
          const id = process.argv[4];
          if (!id || id.startsWith("-")) {
            console.error("usage: penumbra task show <id> [--json]");
            process.exit(1);
          }
          await runTaskShow({
            id,
            json: process.argv.includes("--json"),
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "cancel") {
          const id = process.argv[4];
          if (!id || id.startsWith("-")) {
            console.error("usage: penumbra task cancel <id> [--reason <text>]");
            process.exit(1);
          }
          await runTaskCancel({
            id,
            reason: readOptionalFlagValue("--reason") ?? undefined,
            storageRoot: resolveLiveRoot(),
          });
          process.exit(0);
        }
        if (sub === "review") {
          const id = process.argv[4];
          if (!id || id.startsWith("-")) {
            console.error("usage: penumbra task review <id>");
            process.exit(1);
          }
          await runTaskReview({ id, storageRoot: resolveLiveRoot() });
          process.exit(0);
        }
        if (sub === "watch") {
          await runTaskWatch({ storageRoot: resolveLiveRoot() });
          process.exit(0);
        }
        console.error("usage: penumbra task <new|list|show|cancel|review|watch>");
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "chain":
    {
      const sub = process.argv[3];
      try {
        if (sub === "send-message") {
          const handoff_id = process.argv[4];
          const content = process.argv[5];
          if (!handoff_id || handoff_id.startsWith("-") || content === undefined) {
            console.error("usage: penumbra chain send-message <handoff_id> <content>");
            process.exit(1);
          }
          await runChainSendMessage({ handoff_id, content, storageRoot: resolveLiveRoot() });
          process.exit(0);
        }
        console.error("usage: penumbra chain <send-message>");
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "statusline":
    {
      const { runStatusline } = await import("../src/commands/statusline.js");
      const line = await runStatusline();
      emit(line);
      process.exit(0);
    }
    break;
  case "console":
    {
      const portRaw = readOptionalFlagValue("--port");
      let port: number | undefined;
      if (portRaw !== undefined) {
        const parsed = Number(portRaw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          console.error(
            `penumbra console: --port must be an integer in [0, 65535] (got: ${portRaw})`,
          );
          process.exit(2);
        }
        port = parsed;
      }
      const noOpen = process.argv.includes("--no-open");
      try {
        const r = await runConsole({ port, noOpen, storageRoot: bootstrapRoot });
        process.exit(r.exitCode);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "long-lived":
    {
      try {
        const code = await dispatchLongLivedSubcommand(process.argv.slice(3), resolveLiveRoot());
        process.exit(code);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "worktree":
    {
      const sub = process.argv[3];
      try {
        if (sub === "gc") {
          const apply = process.argv.includes("--apply");
          const graceMsRaw = readOptionalFlagValue("--grace-ms");
          const gracePeriodMs = graceMsRaw !== undefined ? Number(graceMsRaw) : undefined;
          if (
            gracePeriodMs !== undefined &&
            (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0)
          ) {
            console.error("penumbra worktree gc: --grace-ms must be a non-negative number");
            process.exit(1);
          }
          const { runWorktreeGc, PendingHandoffsError } =
            await import("../src/commands/worktree-gc.js");
          try {
            const result = await runWorktreeGc({
              storageRoot: resolveLiveRoot(),
              apply,
              gracePeriodMs,
            });
            if (result.candidates.length === 0) {
              emit("penumbra worktree gc: no eligible worktrees found");
              process.exit(0);
            }
            emit(result.dry_run ? "DRY RUN — pass --apply to remove\n" : "APPLYING GC\n");
            emit(["handoff_id", "branch", "status", "resolved_at", "age_h", "path"].join("\t"));
            for (const c of result.candidates) {
              const age_h = (c.age_ms / 3_600_000).toFixed(1);
              emit([c.handoff_id, c.branch, c.status, c.resolved_at, age_h, c.path].join("\t"));
            }
            if (!result.dry_run) {
              emit(`\nremoved=${String(result.n_removed)} failed=${String(result.n_failed)}`);
            }
            process.exit(0);
          } catch (err) {
            if (err instanceof PendingHandoffsError) {
              console.error(`penumbra worktree gc: ${err.message}`);
              process.exit(2);
            }
            throw err;
          }
        }
        console.error("usage: penumbra worktree gc [--apply] [--grace-ms <ms>]");
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "notes":
    {
      const sub = process.argv[3];
      try {
        if (sub === "rotate") {
          const keepCountRaw = readOptionalFlagValue("--keep-count");
          const keepCount = keepCountRaw === undefined ? undefined : Number(keepCountRaw);
          if (keepCount !== undefined && (!Number.isInteger(keepCount) || keepCount < 1)) {
            console.error(
              `penumbra notes rotate: --keep-count must be a positive integer (got: ${keepCountRaw ?? ""})`,
            );
            process.exit(1);
          }
          const result = await runNotesRotate({
            rootDir: process.cwd(),
            apply: process.argv.includes("--apply"),
            keepCount,
          });
          if (result.would_move.length === 0) {
            emit("penumbra notes rotate: no files to move");
          } else if (result.dry_run) {
            emit("penumbra notes rotate: dry run");
            for (const item of result.would_move) {
              emit(`${item.source} -> ${item.destination}`);
            }
          } else {
            emit(`penumbra notes rotate: moved ${String(result.moved.length)} files`);
            for (const item of result.moved) {
              emit(`${item.source} -> ${item.destination}`);
            }
          }
          process.exit(0);
        }
        console.error("usage: penumbra notes rotate [--apply] [--keep-count <n>]");
        process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    break;
  case "config":
    {
      const sub = process.argv[3];
      if (sub === "--help" || sub === "-h" || sub === undefined) {
        emit("usage: penumbra config <show|split|sync-local|sync-providers|check-aliases>");
        emit("  show  [--json]");
        emit("  split (--source <path> | --source-dir <dir>) --dest <dir> [--force] [--dry-run]");
        emit("  sync-local [--apply | --dry-run]");
        emit("  sync-providers [--apply | --dry-run]");
        emit("  check-aliases");
        process.exit(0);
      }
      if (sub === "show") {
        const json = process.argv.includes("--json");
        const { runConfigShow } = await import("../src/commands/config-show.js");
        await runConfigShow({ json });
        break;
      }
      if (sub === "split") {
        const { runConfigSplit } = await import("../src/commands/config-split.js");
        const source = readOptionalFlagValue("--source");
        const sourceDir = readOptionalFlagValue("--source-dir");
        const dest = readOptionalFlagValue("--dest");
        const force = process.argv.includes("--force");
        const dryRun = process.argv.includes("--dry-run");
        process.exit(await runConfigSplit({ source, sourceDir, dest, force, dryRun }));
      }
      if (sub === "sync-local") {
        const { runConfigSyncLocal } = await import("../src/commands/config-sync-local.js");
        const result = await runConfigSyncLocal({
          apply: process.argv.includes("--apply"),
          dryRun: process.argv.includes("--dry-run"),
        });
        for (const line of result.stdout) emit(line);
        for (const line of result.stderr) console.error(line);
        process.exit(result.exitCode);
      }
      if (sub === "sync-providers") {
        const { runConfigSyncProviders } = await import("../src/commands/config-sync-providers.js");
        const result = await runConfigSyncProviders({
          apply: process.argv.includes("--apply"),
          dryRun: process.argv.includes("--dry-run"),
        });
        for (const line of result.stdout) emit(line);
        for (const line of result.stderr) console.error(line);
        process.exit(result.exitCode);
      }
      if (sub === "check-aliases") {
        const { runConfigCheckAliases } = await import("../src/commands/config-check-aliases.js");
        const result = runConfigCheckAliases({});
        for (const line of result.stdout) emit(line);
        for (const line of result.stderr) console.error(line);
        process.exit(result.exitCode);
      }
      console.error("Usage: penumbra config <show|split|sync-local|sync-providers|check-aliases>");
      process.exit(2);
    }
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    emit(
      "usage: penumbra <init|start|stop|status|export|import|repair|tail|recent|memory|cost|agent|dispatch|recall|workflow|plan|registrar|hook|hooks|task|maestro|long-lived|chain|statusline|console|worktree|notes|config>",
    );
    process.exit(0);
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readOptionalFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("-")) {
    console.error(`usage: penumbra start ${flag} <value>`);
    process.exit(1);
  }
  return value;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
