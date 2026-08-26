#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AaModelSnapshot } from "../packages/core/src/routing/schemas.js";

import {
  buildAliasCoverageReport,
  type AliasCoverageReport,
} from "../packages/cli/src/commands/config-check-aliases.js";
import { loadAgentChatConfigFromDir } from "../packages/config/src/files/load.js";
import { loadModelAliasMapFromDir } from "../packages/config/src/files/model-aliases.js";
import { createAaSnapshotStore } from "../packages/core/src/routing/aa-snapshot-store.js";

export { buildAliasCoverageReport, type AliasCoverageReport };

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
