import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiscoveredModel, DiscoveryDiagnostic, DiscoveryReport } from "./discovery-types.js";

const execFileAsync = promisify(execFile);
const AGY_SOURCE_PROVIDER_ID = "agy";

export interface DiscoverAgyModelsOpts {
  runAgyModels?: () => Promise<string>;
}

export function parseAgyModelsOutputReport(output: string): DiscoveryReport {
  const models: DiscoveredModel[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const separatorIndex = line.indexOf("\t");
    if (separatorIndex < 0) {
      diagnostics.push({ row: line, reason: "missing tab separator" });
      continue;
    }

    const modelId = line.slice(0, separatorIndex).trim();
    const displayName = line.slice(separatorIndex + 1).trim();
    if (modelId.length === 0) {
      diagnostics.push({ row: line, reason: "empty model id" });
      continue;
    }
    if (displayName.length === 0) {
      diagnostics.push({ row: line, reason: "empty display name" });
      continue;
    }
    models.push({
      sourceProviderId: AGY_SOURCE_PROVIDER_ID,
      modelId,
      displayName,
    });
  }

  return { outcome: "discovered", models, diagnostics };
}

export function parseAgyModelsOutput(output: string): DiscoveredModel[] {
  return parseAgyModelsOutputReport(output).models;
}

async function defaultRunAgyModels(): Promise<string> {
  const { stdout } = await execFileAsync("agy", ["models"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function discoverAgyModels(
  opts: DiscoverAgyModelsOpts = {},
): Promise<DiscoveryReport> {
  const output = await (opts.runAgyModels ?? defaultRunAgyModels)();
  return parseAgyModelsOutputReport(output);
}
