import type { CheckReport, RuntimeReport } from "./check.js";
import type { ServiceUnitState } from "./types.js";

function short(sha: string): string {
  return sha.slice(0, 12);
}

function unitLine(unit: ServiceUnitState): string {
  const pid = unit.pid === null ? "" : ` pid ${String(unit.pid)}`;
  return `${unit.name} ${unit.active ? "active" : "inactive"}${pid}`;
}

function runtimeLines(runtime: RuntimeReport): string[] {
  const lines: string[] = [];
  if (runtime.state === null || runtime.serviceManager === null) {
    lines.push(`  service manager: none (${runtime.managerReason ?? "not detected"})`);
  } else {
    lines.push(
      `  service manager: ${runtime.serviceManager} (${unitLine(runtime.state.daemon)}; ${unitLine(runtime.state.worker)})`,
    );
  }
  lines.push(`  runs from: ${runtime.runsFrom.path ?? "unknown"} (${runtime.runsFrom.status})`);
  const port = runtime.health.port === null ? "" : ` on :${String(runtime.health.port)}`;
  lines.push(
    `  daemon: ${runtime.health.ok ? "healthy" : "UNHEALTHY"}${port} (${runtime.health.detail})`,
  );
  const idle = runtime.idle;
  const activity = idle.idle ? "idle" : `busy: ${idle.reasons.join("; ")}`;
  const queued =
    idle.approved === null ? "" : `, ${String(idle.approved)} approved handoff(s) queued`;
  lines.push(`  activity: ${activity}${queued}`);
  if (idle.ignoredSessions.length > 0) {
    lines.push(
      `  ignoring ${String(idle.ignoredSessions.length)} idle agent session(s): ${idle.ignoredSessions.join(", ")}`,
    );
  }
  if (idle.daemonError) lines.push(`  in-flight handoffs unknown: ${idle.daemonError}`);
  return lines;
}

function targetLines(report: CheckReport): string[] {
  if (report.upToDate) return ["  already up to date"];
  const lines = [
    `  new commits: ${String(report.newCommits)}${report.fastForward ? "" : " (NOT a fast-forward)"}`,
    ...report.commits.map((line) => `    ${line}`),
  ];
  if (report.newCommits > report.commits.length) {
    lines.push(`    … (${String(report.newCommits - report.commits.length)} more)`);
  }
  lines.push(
    `  dependencies: ${report.depsChanged ? "changed (bun install --frozen-lockfile will run)" : "unchanged"}`,
    `  CI (check workflow) on target: ${report.ci}`,
  );
  return lines;
}

export function formatCheckReport(report: CheckReport): string[] {
  const lines = [
    `penumbra update: ${report.repo} (branch ${report.branch ?? "DETACHED"})`,
    `  current: ${short(report.current)}`,
    `  target:  ${report.ref} = ${short(report.target)}`,
    ...targetLines(report),
    `  local changes: ${report.trackedChanges.length === 0 ? "none" : String(report.trackedChanges.length)}`,
    ...runtimeLines(report.runtime),
    `  heavy-job lock: ${report.heavyLock.path} (${report.heavyLock.source}); bun: ${report.bun}`,
  ];
  if (report.upToDate) return lines;
  if (report.blockers.length === 0) {
    lines.push("  --apply gates: ok");
  } else {
    lines.push("  --apply would refuse:", ...report.blockers.map((b) => `    - ${b}`));
  }
  return lines;
}

/** Unit Environment= values can hold secrets; report the keys only. */
function redactUnit(unit: ServiceUnitState): Record<string, unknown> {
  const { environment, ...rest } = unit;
  return { ...rest, environment_keys: Object.keys(environment) };
}

export function checkReportJson(report: CheckReport): Record<string, unknown> {
  const { runtime, ...rest } = report;
  return {
    ...rest,
    runtime: {
      service_manager: runtime.serviceManager,
      manager_reason: runtime.managerReason,
      daemon: runtime.state ? redactUnit(runtime.state.daemon) : null,
      worker: runtime.state ? redactUnit(runtime.state.worker) : null,
      runs_from: runtime.runsFrom,
      health: runtime.health,
      idle: runtime.idle,
    },
  };
}
