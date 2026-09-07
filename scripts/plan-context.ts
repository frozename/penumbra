#!/usr/bin/env bun
/**
 * plan-context — emit the constraint block a plan-authoring agent must be
 * handed, read live from this repo and the running daemon.
 *
 * Every fact below was once hand-typed into an authoring prompt, and every one
 * of them drifts: which seat names the plan validator accepts, the extra
 * maestro_capable requirement plan-runtime enforces on top of it, the phase
 * header regex the registrar greps with, the task-id patterns, the real gate
 * commands, and whether the plan directory is tracked by git at all. So none
 * of them is a literal here — each is DERIVED at run time:
 *   seats            GET /chains/agents  n  agents.yaml maestro_capable, minus
 *                    every seat an ACTIVE routing bias excludes
 *   validator rules  parsed from the validator source
 *   format rules     parsed from the registrar, plan parser and plan-meta schema
 *   gate commands    parsed from .github/workflows/check.yml + package.json
 *   plan location    matched against .gitignore
 *
 * Fails closed. With the daemon down this script exits non-zero rather than
 * falling back to a built-in seat list — a stale list is the exact drift it
 * exists to prevent, and `penumbra plan validate` already fails OPEN that way
 * (it warns, then validates against a handful of hardcoded names).
 *
 * Exit codes:
 *   0 — context written to stdout
 *   1 — fail closed: daemon unreachable, agent config unreadable, a source
 *       pattern no longer matches, or no eligible seat remains
 *   2 — usage error
 *
 * Usage:
 *   bun scripts/plan-context.ts
 *   bun scripts/plan-context.ts --format=md
 *   bun scripts/plan-context.ts --repo=<dir> --config-dir=<dir> \
 *     --storage-root=<dir> --plan-dir=docs/plans
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { loadAgentChatConfigFromDir } from "../packages/config/src/files/load.js";
import {
  computeSeatContext,
  parseAgentNames,
  parseBiases,
  type SeatContext,
  type SeatInput,
} from "./plan-context-seats.js";
import {
  buildFormatContext,
  buildGateContext,
  buildPlanLocation,
  buildValidatorContext,
  type FormatContext,
  type GateContext,
  PlanContextError,
  type PlanLocationContext,
  readSources,
  type RepoSources,
  SOURCE_PATHS,
  type ValidatorContext,
} from "./plan-context-sources.js";

export interface PlanContext {
  daemon: { base_url: string; storage_root: string };
  format: FormatContext;
  gates: GateContext;
  generated_at: string;
  plan_location: PlanLocationContext;
  repo_root: string;
  seats: SeatContext;
  sources: Record<string, string>;
  validator: ValidatorContext;
  warnings: string[];
}

const DAEMON_TIMEOUT_MS = 8000;
const DEFAULT_PLAN_DIR = "docs/plans";

export class PlanContextUsageError extends Error {}

/* --------------------------------------------------------------- assembly */

export interface BuildPlanContextInput {
  daemon: { base_url: string; storage_root: string };
  now: Date;
  planDir: string;
  repoRoot: string;
  seats: SeatContext;
  sources: RepoSources;
}

function seatWarnings(seats: SeatContext): string[] {
  const warnings: string[] = [];
  if (seats.eligible.length === 0) {
    warnings.push(
      "no eligible seat: every registered maestro_capable seat is excluded by an active routing bias — a plan pinned now would validate but not run",
    );
  } else if (seats.eligible.length === 1) {
    warnings.push("only one eligible seat: preferred_agent and fallback_agent are the same");
  }
  for (const seat of seats.excluded_by_bias) {
    const bias = seat.bias;
    warnings.push(
      `${seat.name} is registered and maestro_capable but excluded by an active ${bias?.scope ?? "unknown"} bias on "${bias?.value ?? "?"}" until ${bias?.expires_at ?? "further notice"}`,
    );
  }
  for (const name of seats.maestro_capable_unregistered) {
    warnings.push(
      `${name} is maestro_capable in config but absent from the daemon registry: plan validate would reject it`,
    );
  }
  return warnings;
}

function collectWarnings(
  seats: SeatContext,
  format: FormatContext,
  location: PlanLocationContext,
): string[] {
  const warnings = seatWarnings(seats);
  if (format.task_id_accepts_yaml_number) {
    warnings.push(
      'quote every task id: the schema accepts a YAML number and stringifies it, so an unquoted `id: 11.10` becomes "11.1" and collides with task 11.1 silently',
    );
  }
  if (!format.phase_header_probe.ascii_hyphen) {
    warnings.push(
      "a phase header written with an ASCII hyphen does not match the registrar regex: the phase is dropped from the registrar entry with no error",
    );
  }
  if (location.gitignored) {
    warnings.push(
      `${location.dir} is gitignored (${SOURCE_PATHS.gitignore}:${String(location.gitignore_line ?? 0)}): the plan is a local artifact, so a dispatched worker cannot read it from the branch`,
    );
  }
  return warnings;
}

export function buildPlanContext(input: BuildPlanContextInput): PlanContext {
  const format = buildFormatContext(input.sources);
  const location = buildPlanLocation(input.sources.gitignore, input.planDir);
  return {
    daemon: input.daemon,
    format,
    gates: buildGateContext(input.sources.checkYml, input.sources.packageJson),
    generated_at: input.now.toISOString(),
    plan_location: location,
    repo_root: input.repoRoot,
    seats: input.seats,
    sources: { ...SOURCE_PATHS },
    validator: buildValidatorContext(input.sources.validator),
    warnings: collectWarnings(input.seats, format, location),
  };
}

/* -------------------------------------------------------------- rendering */

function renderSeatSection(context: PlanContext): string[] {
  const seats = context.seats;
  const lines = [
    "## Seats (registered AND maestro_capable AND not bias-excluded)",
    "",
    `- preferred_agent: \`${seats.preferred_agent ?? "NONE"}\``,
    `- fallback_agent: \`${seats.fallback_agent ?? "NONE"}\``,
    `- selection: ${seats.selection_reason}`,
    `- eligible (${String(seats.eligible.length)} of ${String(seats.maestro_capable_count)} maestro_capable; ${String(seats.registered_count)} seats registered):`,
  ];
  for (const seat of seats.eligible) {
    lines.push(
      `  - \`${seat.name}\` (provider ${seat.provider ?? "unknown"}, bias factor ${String(seat.factor)})`,
    );
  }
  if (seats.excluded_by_bias.length > 0) {
    lines.push("- excluded by an ACTIVE routing bias (do not pin these):");
    for (const seat of seats.excluded_by_bias) {
      lines.push(
        `  - \`${seat.name}\` (${seat.bias?.scope ?? "unknown"} bias on "${seat.bias?.value ?? "?"}")`,
      );
    }
  }
  lines.push("", "The validator rejects a ROLE such as `executor`; pin a name above verbatim.", "");
  return lines;
}

function renderFormatSection(context: PlanContext): string[] {
  const format = context.format;
  const probe = format.phase_header_probe;
  const separators = [
    probe.em_dash ? "em dash U+2014, one space either side" : null,
    probe.colon ? "colon + space" : null,
    probe.ascii_hyphen ? "ASCII hyphen" : null,
  ].filter((value): value is string => value !== null);
  return [
    "## Format contract",
    "",
    `- phase header regex (${SOURCE_PATHS.registrar}): \`${format.phase_header_regex}\``,
    `- accepted phase-header separators: ${separators.join(", ")}`,
    `- task heading prefix \`${format.task_heading_prefix}\`; a \`${format.heading_clear_prefix}\` line clears the pending heading`,
    `- depends_on ids match \`${format.depends_on_id_pattern}\` (cross-project: \`${format.qualified_depends_on_id_pattern}\`)`,
    `- parallel_with must be reciprocal: ${String(context.validator.parallel_with_must_be_reciprocal)}`,
    `- task ids accept a YAML number: ${String(format.task_id_accepts_yaml_number)}${
      format.task_id_accepts_yaml_number ? " — QUOTE every id" : ""
    }`,
    `- file_scope: ${format.enums.file_scope.join(" | ")}`,
    `- task_size: ${format.enums.task_size.join(" | ")}`,
    `- risk_class: ${format.enums.risk_class.join(" | ")}`,
    "",
  ];
}

function renderGateSection(context: PlanContext): string[] {
  const gates = context.gates;
  const lines = ["## Gate commands (derived from CI)", "", "Blocking, in CI order:"];
  for (const command of gates.blocking_commands) {
    lines.push(`- \`${command}\``);
  }
  if (gates.advisory_commands.length > 0) {
    lines.push("", "Advisory (does not block):");
    for (const command of gates.advisory_commands) {
      lines.push(`- \`${command}\``);
    }
  }
  lines.push("", "Test shards — root `bun test` is NOT the gate:");
  for (const command of gates.shard_commands) {
    lines.push(`- \`${command}\``);
  }
  const expansions = Object.entries(gates.package_script_expansions);
  if (expansions.length > 0) {
    lines.push("", "Script expansions:");
    for (const [name, expansion] of expansions) {
      lines.push(`- \`bun run ${name}\` -> \`${expansion}\``);
    }
  }
  lines.push("");
  return lines;
}

function renderTailSection(context: PlanContext): string[] {
  const location = context.plan_location;
  const provenance =
    location.pattern === null
      ? ""
      : ` (${SOURCE_PATHS.gitignore}:${String(location.gitignore_line ?? 0)} \`${location.pattern}\`)`;
  const lines = [
    "## Validator rules",
    "",
    `Enforced by ${context.validator.source}: ${context.validator.rules.join(", ")}.`,
    `\`file_scope: new\` is checked against the working tree: ${String(context.validator.file_scope_new_checked_on_disk)}.`,
    "",
    "## Plan location",
    "",
    `- ${location.dir} gitignored: ${String(location.gitignored)}${provenance}`,
    "",
  ];
  if (context.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of context.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  return lines;
}

export function renderMarkdown(context: PlanContext): string {
  return [
    "# Plan authoring context",
    "",
    `Generated ${context.generated_at} from ${context.repo_root} and ${context.daemon.base_url}.`,
    "Every value below is read live from the repo and the daemon; none is a literal.",
    "",
    ...renderSeatSection(context),
    ...renderFormatSection(context),
    ...renderGateSection(context),
    ...renderTailSection(context),
  ].join("\n");
}

export function summaryLine(context: PlanContext): string {
  return [
    `plan-context: ${String(context.seats.eligible.length)} eligible seat(s)`,
    `preferred ${context.seats.preferred_agent ?? "NONE"}`,
    `${String(context.validator.rules.length)} validator rules`,
    `${String(context.gates.blocking_commands.length)} blocking gate command(s)`,
    `${String(context.warnings.length)} warning(s)`,
  ].join(", ");
}

/* ------------------------------------------------------------------ shell */

export interface CliArgs {
  configDir: string;
  format: "json" | "md";
  planDir: string;
  repoRoot: string;
  storageRoot: string | null;
}

function splitFlag(raw: string): [string, string | null] {
  const at = raw.indexOf("=");
  if (at < 0) {
    return [raw, null];
  }
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** Each applier returns false when the value is not one this flag accepts. */
type FlagApplier = (args: CliArgs, value: string) => boolean;

const FLAG_APPLIERS: Record<string, FlagApplier> = {
  "--config-dir": (args, value) => {
    args.configDir = resolve(value);
    return true;
  },
  "--format": (args, value) => {
    if (value !== "json" && value !== "md") {
      return false;
    }
    args.format = value;
    return true;
  },
  "--plan-dir": (args, value) => {
    args.planDir = value;
    return true;
  },
  "--repo": (args, value) => {
    args.repoRoot = resolve(value);
    return true;
  },
  "--storage-root": (args, value) => {
    args.storageRoot = resolve(value);
    return true;
  },
};

export function parseArgs(
  argv: readonly string[],
  defaults: { configDir: string; repoRoot: string },
): CliArgs {
  const args: CliArgs = {
    configDir: defaults.configDir,
    format: "json",
    planDir: DEFAULT_PLAN_DIR,
    repoRoot: defaults.repoRoot,
    storageRoot: null,
  };
  for (const raw of argv) {
    const [flag, value] = splitFlag(raw);
    const apply = FLAG_APPLIERS[flag];
    if (apply === undefined || value === null || !apply(args, value)) {
      throw new PlanContextUsageError(
        `unknown or malformed argument "${raw}"; usage: bun scripts/plan-context.ts [--format=json|md] [--repo=<dir>] [--config-dir=<dir>] [--storage-root=<dir>] [--plan-dir=<dir>]`,
      );
    }
  }
  return args;
}

export function resolveStorageRoot(explicit: string | null): string {
  const candidates =
    explicit === null
      ? [process.env["PENUMBRA_STORAGE_ROOT"], join(homedir(), ".penumbra"), "/tmp/penumbra-live"]
      : [explicit];
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      existsSync(join(candidate, "port")) &&
      existsSync(join(candidate, "token"))
    ) {
      return candidate;
    }
  }
  throw new PlanContextError(
    "no daemon storage root carries both port and token; start the daemon or pass --storage-root=<dir>. Refusing to fall back to a built-in seat list.",
  );
}

export interface DaemonHandle {
  baseUrl: string;
  token: string;
}

export function readDaemonHandle(storageRoot: string): DaemonHandle {
  const port = Number(readFileSync(join(storageRoot, "port"), "utf8").trim());
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PlanContextError(`invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (token.length === 0) {
    throw new PlanContextError(`empty daemon token in ${join(storageRoot, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
}

async function fetchDaemonJson(handle: DaemonHandle, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${handle.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PlanContextError(
      `daemon unreachable at ${handle.baseUrl}${path} (${error instanceof Error ? error.message : String(error)}); refusing to emit a stale seat list`,
    );
  }
  if (!response.ok) {
    throw new PlanContextError(
      `daemon returned HTTP ${String(response.status)} for ${path}; refusing to emit a stale seat list`,
    );
  }
  return await response.json();
}

/** maestro_capable is not reachable over HTTP, so the config file is required. */
export function readSeatConfig(configDir: string): SeatInput[] {
  try {
    return loadAgentChatConfigFromDir(configDir).agents.map((agent) => ({
      api_provider: agent.api_provider ?? null,
      maestro_capable: agent.maestro_capable === true,
      name: agent.name,
      pricing_mode: agent.pricing_mode,
      subscription_provider: agent.subscription_provider ?? null,
    }));
  } catch (error) {
    throw new PlanContextError(
      `could not read the agent config in ${configDir} (${error instanceof Error ? error.message : String(error)}); maestro_capable is not exposed over HTTP, so this file is required`,
    );
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), {
    configDir: join(homedir(), ".config", "penumbra"),
    repoRoot: resolve(import.meta.dir, ".."),
  });
  const storageRoot = resolveStorageRoot(args.storageRoot);
  const handle = readDaemonHandle(storageRoot);
  const [agentsPayload, biasPayload] = await Promise.all([
    fetchDaemonJson(handle, "/chains/agents"),
    fetchDaemonJson(handle, "/routing/bias"),
  ]);
  const now = new Date();
  const context = buildPlanContext({
    daemon: { base_url: handle.baseUrl, storage_root: storageRoot },
    now,
    planDir: args.planDir,
    repoRoot: args.repoRoot,
    seats: computeSeatContext({
      biases: parseBiases(biasPayload),
      now,
      registered: parseAgentNames(agentsPayload),
      seats: readSeatConfig(args.configDir),
    }),
    sources: readSources(args.repoRoot),
  });
  process.stdout.write(
    args.format === "md" ? renderMarkdown(context) : `${JSON.stringify(context, null, 2)}\n`,
  );
  console.error(summaryLine(context));
  return context.seats.eligible.length === 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`plan-context: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof PlanContextUsageError ? 2 : 1;
  }
}
