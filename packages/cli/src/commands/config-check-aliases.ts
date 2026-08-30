import {
  AgentsConfigSchema,
  isCanonicalProviderValue,
  loadModelAliasMapFromDir,
  type ModelAliasMap,
} from "@penumbra/config";
import {
  type AaModelSnapshot,
  type AliasUnmatchedReason,
  buildAliasIndex,
  createAaSnapshotStore,
  reconcileAliases,
} from "@penumbra/core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export interface AliasCoverageEntry {
  seatName: string;
  status: "matched" | "dark" | "missing";
  aaCreator?: string;
  aaSlug?: string;
  reason?: AliasUnmatchedReason;
}

export interface AliasCoverageReport {
  matched: string[];
  dark: string[];
  missing: string[];
  entries: AliasCoverageEntry[];
}

export interface SameCreatorUnseatedModel {
  aaCreator: string;
  aaSlug: string;
  aaId: string;
  aaName: string;
}

export interface ConfigCheckAliasesReport extends AliasCoverageReport {
  sameCreatorUnseated: SameCreatorUnseatedModel[];
}

export interface ConfigCheckAliasesResult {
  exitCode: 0;
  stdout: string[];
  stderr: string[];
  report: ConfigCheckAliasesReport;
}

export interface RunConfigCheckAliasesOpts {
  configDir?: string;
  env?: Record<string, string | undefined>;
  loadSnapshot?: () => AaModelSnapshot;
}

/**
 * Thin wrapper over the router's own alias matching (buildAliasIndex + reconcileAliases):
 * buckets each seat name into matched / dark (aliased but no snapshot match) / missing (no alias).
 */
export function buildAliasCoverageReport(
  aliases: ModelAliasMap,
  snapshot: AaModelSnapshot,
  seatNames: readonly string[],
): AliasCoverageReport {
  const index = buildAliasIndex(aliases);
  const reconciled = reconcileAliases(index, snapshot, seatNames);

  const matched: string[] = [];
  const dark: string[] = [];
  const missing: string[] = [];
  const entries: AliasCoverageEntry[] = [];

  for (const seatName of seatNames) {
    const result = reconciled[seatName];
    if (!result) continue;

    if ("matched" in result) {
      matched.push(seatName);
      const alias = index.get(seatName);
      entries.push({
        seatName,
        status: "matched",
        aaCreator: alias?.aaCreator,
        aaSlug: alias?.aaSlug,
      });
      continue;
    }

    if (result.unmatched === "no_alias_configured") {
      missing.push(seatName);
      entries.push({ seatName, status: "missing", reason: result.unmatched });
    } else {
      dark.push(seatName);
      entries.push({ seatName, status: "dark", reason: result.unmatched });
    }
  }

  return { matched, dark, missing, entries };
}

function canonicalCreator(value: string): string {
  if (isCanonicalProviderValue(value)) return value;
  const lower = value.toLowerCase();
  return isCanonicalProviderValue(lower) ? lower : value;
}

function pairKey(creator: string, slug: string): string {
  return `${creator}::${slug}`;
}

/**
 * Same-creator unseated-AA delta: an AA snapshot model whose creator matches a
 * creator some seat is already aliased to, but the model itself (creator+slug)
 * is not the target of any seat's alias. Surfaces new sibling models from a
 * provider penumbra already tracks, without requiring a new creator relationship.
 */
export function computeSameCreatorUnseatedDelta(
  aliases: ModelAliasMap,
  snapshot: AaModelSnapshot,
): SameCreatorUnseatedModel[] {
  const aliasedCreators = new Set<string>();
  const aliasedPairs = new Set<string>();
  for (const alias of Object.values(aliases)) {
    aliasedCreators.add(alias.aa_creator);
    aliasedPairs.add(pairKey(alias.aa_creator, alias.aa_slug));
  }

  const delta: SameCreatorUnseatedModel[] = [];
  for (const model of snapshot.models) {
    const creator = canonicalCreator(model.model_creator.slug);
    if (!aliasedCreators.has(creator)) continue;
    if (aliasedPairs.has(pairKey(creator, model.slug))) continue;
    delta.push({ aaCreator: creator, aaSlug: model.slug, aaId: model.id, aaName: model.name });
  }
  return delta;
}

function resolveConfigDir(env: Record<string, string | undefined>): string {
  if (env.PENUMBRA_CONFIG_DIR && env.PENUMBRA_CONFIG_DIR.length > 0) return env.PENUMBRA_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, "penumbra");
  }
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".config", "penumbra");
}

function readSeatNames(configDir: string): string[] {
  const path = join(configDir, "agents.yaml");
  const parsed = YAML.parse(readFileSync(path, "utf8")) as unknown;
  return AgentsConfigSchema.parse(parsed).agents.map((agent) => agent.name);
}

function readSnapshotFromStore(): AaModelSnapshot {
  const read = createAaSnapshotStore().readSync();
  if (read.state !== "available") return { collectedAt: "", models: [] };
  return {
    collectedAt: read.snapshot.provenance.collectedAt,
    dataVersion: read.snapshot.provenance.dataVersion,
    benchmarkVersion: read.snapshot.provenance.benchmarkVersion,
    models: read.snapshot.models,
  };
}

function formatReport(report: ConfigCheckAliasesReport): string[] {
  const lines: string[] = [];

  lines.push(`Matched (${String(report.matched.length)}):`);
  for (const entry of report.entries) {
    if (entry.status === "matched") {
      lines.push(`  ${entry.seatName} -> ${entry.aaCreator ?? "?"}/${entry.aaSlug ?? "?"}`);
    }
  }

  lines.push(`Dark (${String(report.dark.length)}):`);
  for (const entry of report.entries) {
    if (entry.status === "dark") {
      lines.push(`  ${entry.seatName} (${entry.reason ?? "unknown"})`);
    }
  }

  lines.push(`Missing (${String(report.missing.length)}):`);
  for (const entry of report.entries) {
    if (entry.status === "missing") {
      lines.push(`  ${entry.seatName}`);
    }
  }

  lines.push(`Same-creator unseated AA models (${String(report.sameCreatorUnseated.length)}):`);
  for (const model of report.sameCreatorUnseated) {
    lines.push(`  ${model.aaCreator}/${model.aaSlug}`);
  }

  return lines;
}

/**
 * A report, not a gate: always exits 0, even when config or the AA snapshot
 * can't be loaded. Failures surface as a stderr line, not a nonzero exit.
 */
export function runConfigCheckAliases(
  opts: RunConfigCheckAliasesOpts = {},
): ConfigCheckAliasesResult {
  const env = opts.env ?? process.env;
  const configDir = opts.configDir ?? resolveConfigDir(env);
  const stderr: string[] = [];

  let seatNames: string[];
  let aliases: ModelAliasMap;
  let snapshot: AaModelSnapshot;
  try {
    seatNames = readSeatNames(configDir);
    aliases = loadModelAliasMapFromDir(configDir);
    snapshot = (opts.loadSnapshot ?? readSnapshotFromStore)();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(`penumbra config check-aliases: ${message}`);
    const report: ConfigCheckAliasesReport = {
      matched: [],
      dark: [],
      missing: [],
      entries: [],
      sameCreatorUnseated: [],
    };
    return { exitCode: 0, stdout: formatReport(report), stderr, report };
  }

  const coverage = buildAliasCoverageReport(aliases, snapshot, seatNames);
  const sameCreatorUnseated = computeSameCreatorUnseatedDelta(aliases, snapshot);
  const report: ConfigCheckAliasesReport = { ...coverage, sameCreatorUnseated };

  return { exitCode: 0, stdout: formatReport(report), stderr, report };
}
