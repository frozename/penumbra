import type { DiscoveredModel } from "./discovery-types.js";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CAPABILITY_KEYS = [
  "attachment",
  "reasoning",
  "tool_call",
  "structured_output",
  "temperature",
  "modalities",
] as const;

export interface FetchModelsDevPayloadOpts {
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelFromProvider(
  provider: unknown,
  modelId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(provider) || !isRecord(provider.models)) return undefined;
  const model = provider.models[modelId];
  return isRecord(model) ? model : undefined;
}

function findModelsDevModel(
  apiPayload: unknown,
  modelId: string,
): { model: Record<string, unknown>; providerId: string } | undefined {
  if (!isRecord(apiPayload)) return undefined;

  const separatorIndex = modelId.indexOf("/");
  const bareModelId = separatorIndex > 0 ? modelId.slice(separatorIndex + 1) : modelId;
  if (separatorIndex > 0) {
    const providerId = modelId.slice(0, separatorIndex);
    const model = modelFromProvider(apiPayload[providerId], bareModelId);
    if (model) return { model, providerId };
  }

  let uniqueMatch: { model: Record<string, unknown>; providerId: string } | undefined;
  for (const [providerId, provider] of Object.entries(apiPayload)) {
    const model = modelFromProvider(provider, bareModelId);
    if (!model) continue;
    if (uniqueMatch) return undefined;
    uniqueMatch = { model, providerId };
  }

  return uniqueMatch;
}

function modelsDevMetadata(
  model: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    modelsDevProvider: providerId,
  };
  if (isRecord(model.cost)) metadata.cost = model.cost;
  if (isRecord(model.limit) && typeof model.limit.context === "number") {
    metadata.context = model.limit.context;
  }

  const capabilities: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    if (key in model) capabilities[key] = model[key];
  }
  if (Object.keys(capabilities).length > 0) metadata.capabilities = capabilities;

  return metadata;
}

export function joinModelsDevMetadata(
  models: DiscoveredModel[],
  apiPayload: unknown,
): DiscoveredModel[] {
  return models.map((model) => {
    const match = findModelsDevModel(apiPayload, model.modelId);
    if (!match) return model;

    return {
      ...model,
      metadata: {
        ...model.metadata,
        ...modelsDevMetadata(match.model, match.providerId),
      },
    };
  });
}

export async function fetchModelsDevPayload(
  opts: FetchModelsDevPayloadOpts = {},
): Promise<unknown> {
  const response = await (opts.fetch ?? globalThis.fetch)(MODELS_DEV_API_URL);
  if (!response.ok) {
    throw new Error(`models.dev request failed with HTTP ${response.status}`);
  }
  return response.json();
}
