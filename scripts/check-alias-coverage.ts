#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AaModelSnapshot } from "../packages/core/src/routing/schemas.js";

import { loadAgentChatConfigFromDir } from "../packages/config/src/files/load.js";
import {
  loadModelAliasMapFromDir,
  type ModelAliasMap,
} from "../packages/config/src/files/model-aliases.js";
import { createAaSnapshotStore } from "../packages/core/src/routing/aa-snapshot-store.js";
import {
  type AliasUnmatchedReason,
  buildAliasIndex,
  reconcileAliases,
} from "../packages/core/src/routing/alias-map.js";

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

function formatReport(report: AliasCoverageReport, snapshotState: string): string {
  const lines: string[] = [`AA snapshot: ${snapshotState}`, ""];

  lines.push(`Matched (${String(report.matched.length)}):`);
  for (const entry of report.entries) {
    if (entry.status === "matched") {
      lines.push(`  ${entry.seatName} -> ${entry.aaCreator ?? "?"}/${entry.aaSlug ?? "?"}`);
    }
  }
  lines.push("");

  lines.push(`Dark (${String(report.dark.length)}):`);
  for (const entry of report.entries) {
    if (entry.status === "dark") {
      lines.push(`  ${entry.seatName} (${entry.reason ?? "unknown"})`);
    }
  }
  lines.push("");

  lines.push(`Missing (${String(report.missing.length)}):`);
  for (const entry of report.entries) {
    if (entry.status === "missing") {
      lines.push(`  ${entry.seatName}`);
    }
  }

  return lines.join("\n") + "\n";
}

function main(): void {
  const configDir = resolve(process.argv[2] ?? join(homedir(), ".config", "penumbra"));

  const agentsConfig = loadAgentChatConfigFromDir(configDir);
  const seatNames = agentsConfig.agents.map((agent) => agent.name);

  const aliases = loadModelAliasMapFromDir(configDir);

  const store = createAaSnapshotStore();
  const read = store.readSync();
  const snapshot: AaModelSnapshot =
    read.state === "available"
      ? {
          collectedAt: read.snapshot.provenance.collectedAt,
          dataVersion: read.snapshot.provenance.dataVersion,
          benchmarkVersion: read.snapshot.provenance.benchmarkVersion,
          models: read.snapshot.models,
        }
      : { collectedAt: "", models: [] };

  const report = buildAliasCoverageReport(aliases, snapshot, seatNames);
  process.stdout.write(formatReport(report, read.state));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(
      `check-alias-coverage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
