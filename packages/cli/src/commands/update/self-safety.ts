import type { HostPort, RuntimeState, ServiceManager } from "./types.js";

const MAX_ANCESTRY_DEPTH = 64;

export type SelfSafety = { ok: true } | { ok: false; reason: string };

/**
 * User-manager units on this process's cgroup v2 path, outermost first, e.g.
 * `0::/user.slice/user-1000.slice/user@1000.service/app.slice/penumbra-worker.service`
 * gives `["penumbra-worker.service"]`.
 */
export function userUnitsInCgroup(cgroupText: string, uid: number): string[] {
  const line = cgroupText.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return [];
  const segments = line.slice(3).split("/").filter(Boolean);
  const managerIdx = segments.indexOf(`user@${String(uid)}.service`);
  if (managerIdx === -1) return [];
  return segments
    .slice(managerIdx + 1)
    .filter((segment) => /^[\w:.@\\-]+\.(?:service|scope)$/.test(segment));
}

async function cgroupRefusal(host: HostPort, manager: ServiceManager): Promise<string | null> {
  const runtime = new Set([manager.daemonName, manager.workerName]);
  const units = userUnitsInCgroup((await host.selfCgroup()) ?? "", host.uid);
  const inside = units.find((unit) => runtime.has(unit));
  if (inside) return `this process runs inside ${inside}`;
  for (const scope of units.filter((unit) => /^penumbra-.+\.scope$/.test(unit))) {
    const binds = await manager.bindsTo(scope);
    if (binds === null) return `this process runs inside ${scope}, whose BindsTo= is unreadable`;
    const bound = binds.find((unit) => runtime.has(unit));
    if (bound) return `this process runs inside ${scope}, which is bound to ${bound}`;
  }
  return null;
}

async function ancestryRefusal(host: HostPort, state: RuntimeState): Promise<string | null> {
  const owners = new Map<number, string>();
  for (const unit of [state.daemon, state.worker]) {
    if (unit.pid !== null) owners.set(unit.pid, unit.name);
  }
  let pid: number | null = host.pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && pid !== null && pid > 1; depth++) {
    const owner = owners.get(pid);
    if (owner) return `this process descends from ${owner} (pid ${String(pid)})`;
    pid = await host.parentPid(pid);
  }
  return null;
}

export function detachedHint(manager: ServiceManager | null, command: string): string {
  if (manager?.kind === "launchd") return "run it from a terminal session instead";
  return `run it from a terminal, or detached: systemd-run --user --unit penumbra-update --collect -- ${command}`;
}

/**
 * Refuses when the restart would kill this process: it runs inside the daemon or
 * worker unit, inside a `penumbra-*.scope` bound to one of them (a dispatched job),
 * or below their main processes.
 */
export async function checkSelfSafety(
  host: HostPort,
  manager: ServiceManager | null,
  state: RuntimeState | null,
  command: string,
): Promise<SelfSafety> {
  if (manager === null || state === null) return { ok: true };
  const why = (await cgroupRefusal(host, manager)) ?? (await ancestryRefusal(host, state));
  if (why === null) return { ok: true };
  return {
    ok: false,
    reason: `the restart would kill this process (${why}); ${detachedHint(manager, command)}`,
  };
}
