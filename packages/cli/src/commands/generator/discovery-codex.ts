import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiscoveredModel } from "./discovery-types.js";

const execFileAsync = promisify(execFile);
const CODEX_SOURCE_PROVIDER_ID = "codex";

export interface DiscoverCodexModelsOpts {
  runCodexDebugModels?: () => Promise<string>;
}

interface CodexDebugModelsPayload {
  models: CodexDebugModel[];
}

interface CodexDebugModel {
  slug?: unknown;
  display_name?: unknown;
  supported_reasoning_levels?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSupportedReasoningTiers(model: CodexDebugModel): string[] {
  if (!Array.isArray(model.supported_reasoning_levels)) return [];
  return [
    ...new Set(
      model.supported_reasoning_levels.flatMap((level) =>
        isRecord(level) && typeof level.effort === "string" ? [level.effort] : [],
      ),
    ),
  ];
}

function parsePayload(output: string): CodexDebugModelsPayload {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    throw new Error("codex debug models output must be an object with a models array");
  }
  return { models: parsed.models as CodexDebugModel[] };
}

export function parseCodexDebugModelsOutput(output: string): DiscoveredModel[] {
  return parsePayload(output).models.flatMap((model) => {
    if (typeof model.slug !== "string" || typeof model.display_name !== "string") return [];
    const base = {
      sourceProviderId: CODEX_SOURCE_PROVIDER_ID,
      modelId: model.slug,
      displayName: model.display_name,
    };
    const tiers = parseSupportedReasoningTiers(model);
    if (tiers.length === 0) return [base];
    return tiers.map((reasoningTier) => ({ ...base, reasoningTier }));
  });
}

async function defaultRunCodexDebugModels(): Promise<string> {
  const { stdout } = await execFileAsync("codex", ["debug", "models"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function discoverCodexModels(
  opts: DiscoverCodexModelsOpts = {},
): Promise<DiscoveredModel[]> {
  const output = await (opts.runCodexDebugModels ?? defaultRunCodexDebugModels)();
  return parseCodexDebugModelsOutput(output);
}
