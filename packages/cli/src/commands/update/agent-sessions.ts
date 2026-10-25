import { loadConfigPathOrDir } from "@penumbra/agentchat/config";
import { basename, join } from "node:path";

/** Runners that only launch other programs; their own name never identifies an agent session. */
export const GENERIC_RUNNERS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "node",
  "npx",
  "uvx",
  "python",
  "python3",
]);

/** The exec a seat spawns, as recorded in its agentchat options. */
export interface SeatExec {
  executable: string | undefined;
  args?: readonly string[];
}

function seatProgramName(seat: SeatExec): string | null {
  if (seat.executable === undefined || seat.executable.trim() === "") return null;
  const base = basename(seat.executable);
  if (!GENERIC_RUNNERS.has(base)) return base;
  const first = seat.args?.[0];
  if (first === undefined || first.trim() === "") return null;
  const argBase = basename(first);
  return GENERIC_RUNNERS.has(argBase) ? null : argBase;
}

/** Adapter program names identifying the seats' agent sessions. */
export function adapterProgramNames(seats: Iterable<SeatExec>): Set<string> {
  const names = new Set<string>();
  for (const seat of seats) {
    const name = seatProgramName(seat);
    if (name !== null) names.add(name);
  }
  return names;
}

/** The adapter program an argv identifies, or null when it is not an agent session. */
export function matchedAgentProgram(
  argv: readonly string[],
  programNames: ReadonlySet<string>,
): string | null {
  for (const entry of argv.slice(0, 3)) {
    const base = basename(entry);
    if (GENERIC_RUNNERS.has(base)) continue;
    if (programNames.has(base)) return base;
  }
  return null;
}

export function isAgentSession(
  argv: readonly string[],
  programNames: ReadonlySet<string>,
): boolean {
  return matchedAgentProgram(argv, programNames) !== null;
}

/**
 * Adapter program names from the same seat config the worker loads
 * (AGENTCHAT_CONFIG or ~/.config/penumbra); null when it cannot be read.
 */
export function loadAdapterProgramNames(env: NodeJS.ProcessEnv, home: string): Set<string> | null {
  try {
    const pathOrDir = env.AGENTCHAT_CONFIG ?? join(home, ".config", "penumbra");
    const config = loadConfigPathOrDir(pathOrDir);
    return adapterProgramNames(
      config.agents.map((agent) => ({
        executable: agent.options.binary ?? agent.options.command,
        args: agent.options.args,
      })),
    );
  } catch {
    return null;
  }
}
