import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiscoveredModel, DiscoveryDiagnostic, DiscoveryReport } from "./discovery-types.js";

const execFileAsync = promisify(execFile);
const DEVIN_SOURCE_PROVIDER_ID = "devin";
const DISCOVERY_CLI_TIMEOUT_MS = 30_000;
const FREE_COST_TIER = "Free";
const FORBIDDEN_FAMILY_PREFIXES = ["claude-", "gpt-", "gemini-"];

export interface DiscoverDevinModelsOpts {
  runDevinModels?: () => Promise<string>;
}

interface DevinVariant {
  model_uid?: unknown;
  label?: unknown;
  cost_tier?: unknown;
  max_context_tokens?: unknown;
  is_beta?: unknown;
}

interface DevinFamily {
  family_uid?: unknown;
  family_label?: unknown;
  slug?: unknown;
  variants?: unknown[];
}

interface DevinModelsPayload {
  families?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasForbiddenFamilyPrefix(familyUid: string): boolean {
  return FORBIDDEN_FAMILY_PREFIXES.some((prefix) => familyUid.startsWith(prefix));
}

interface VariantResult {
  model?: DiscoveredModel;
  diagnostic?: DiscoveryDiagnostic;
}

function classifyVariant(
  variantEntry: unknown,
  familyUid: string,
  familyLabel: string,
): VariantResult {
  if (!isRecord(variantEntry)) {
    return {
      diagnostic: { row: JSON.stringify(variantEntry), reason: "variant is not an object" },
    };
  }
  const variant = variantEntry as DevinVariant;
  const modelUid = typeof variant.model_uid === "string" ? variant.model_uid : "";
  const label = typeof variant.label === "string" ? variant.label : "";

  if (modelUid.length === 0) {
    return { diagnostic: { row: JSON.stringify(variantEntry), reason: "empty model_uid" } };
  }
  if (label.length === 0) {
    return { diagnostic: { row: modelUid, reason: "empty label" } };
  }

  if (hasForbiddenFamilyPrefix(familyUid)) {
    return {
      diagnostic: {
        row: modelUid,
        reason: `refused: family ${JSON.stringify(familyUid)} is a forbidden third-party family under provider devin (would bypass anthropic-reserve routing bias)`,
      },
    };
  }

  const costTier = typeof variant.cost_tier === "string" ? variant.cost_tier : "";
  if (costTier !== FREE_COST_TIER) {
    return {
      diagnostic: {
        row: modelUid,
        reason: `refused: cost_tier ${JSON.stringify(costTier)} is not ${JSON.stringify(FREE_COST_TIER)} (promo-end tripwire)`,
      },
    };
  }

  const maxContext =
    typeof variant.max_context_tokens === "number" ? variant.max_context_tokens : undefined;
  const isBeta = variant.is_beta === true;

  return {
    model: {
      sourceProviderId: DEVIN_SOURCE_PROVIDER_ID,
      modelId: modelUid,
      displayName: label,
      metadata: {
        family: familyUid,
        familyLabel,
        costTier,
        ...(maxContext !== undefined ? { context: maxContext } : {}),
        isBeta,
      },
    },
  };
}

function processFamily(
  familyEntry: unknown,
  models: DiscoveredModel[],
  diagnostics: DiscoveryDiagnostic[],
): void {
  if (!isRecord(familyEntry)) {
    diagnostics.push({ row: JSON.stringify(familyEntry), reason: "family is not an object" });
    return;
  }
  const family = familyEntry as DevinFamily;
  const familyUid = typeof family.family_uid === "string" ? family.family_uid : "";
  const familyLabel = typeof family.family_label === "string" ? family.family_label : familyUid;

  if (!Array.isArray(family.variants)) {
    diagnostics.push({
      row: familyUid || JSON.stringify(familyEntry),
      reason: "family has no variants array",
    });
    return;
  }

  for (const variantEntry of family.variants) {
    const result = classifyVariant(variantEntry, familyUid, familyLabel);
    if (result.model) models.push(result.model);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }
}

export function parseDevinModelsOutputReport(output: string): DiscoveryReport {
  const models: DiscoveredModel[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error("devin models output must be valid JSON");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.families)) {
    throw new Error("devin models output must be an object with a families array");
  }

  const payload = parsed as DevinModelsPayload;
  for (const familyEntry of payload.families ?? []) {
    processFamily(familyEntry, models, diagnostics);
  }

  return { outcome: "discovered", models, diagnostics };
}

export function parseDevinModelsOutput(output: string): DiscoveredModel[] {
  return parseDevinModelsOutputReport(output).models;
}

async function defaultRunDevinModels(): Promise<string> {
  const promise = execFileAsync("devin", ["models", "list", "--format", "json"], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: DISCOVERY_CLI_TIMEOUT_MS,
  });
  promise.child.stdin?.end();
  const { stdout } = await promise;
  return stdout;
}

export async function discoverDevinModels(
  opts: DiscoverDevinModelsOpts = {},
): Promise<DiscoveryReport> {
  const output = await (opts.runDevinModels ?? defaultRunDevinModels)();
  return parseDevinModelsOutputReport(output);
}
