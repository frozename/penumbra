import {
  type AgentConfig,
  type AgentsConfig,
  AgentsConfigSchema,
  applyBindingCarriers,
  assertDiscoveryNotSuspiciouslyEmpty,
  GENERATOR_PROVENANCE_SOURCE,
  type GeneratorSafetyGateResult,
  loadModelAliasMapFromDir,
  loadProviderSourcesFromDir,
  type ModelAliasMap,
  ModelAliasMapSchema,
  type ProviderBinding,
  type ProviderSource,
  pruneOwnedOnly,
  renderTemplateTokens,
  type RoutingConfig,
  RoutingConfigSchema,
  runGeneratorSafetyGate,
  seatNameFor,
  type SeatNameInput,
  upsertManagedFields,
} from "@penumbra/config";
import { resolveDaemonStorageRoot } from "@penumbra/core";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import type {
  DiscoveredModel,
  DiscoveryDiagnostic,
  DiscoveryReport,
} from "./generator/discovery-types.js";

import { executeConfigSplitWrite } from "./config-split.js";
import {
  type AcpSessionSpawner,
  discoverAcpSessionModels,
} from "./generator/discovery-acp-session.js";
import { discoverAgyModels } from "./generator/discovery-agy.js";
import { discoverCodexModels } from "./generator/discovery-codex.js";
import { discoverHttpModels, type HttpModelDiscoveryResult } from "./generator/discovery-http.js";
import { fetchModelsDevPayload, joinModelsDevMetadata } from "./generator/discovery-models-dev.js";
import { discoverOpencodeModels } from "./generator/discovery-opencode.js";

const PROVENANCE_SOURCE = GENERATOR_PROVENANCE_SOURCE;
const ALLOWED_BILLED_HTTP_PROVIDERS = ["local", "sakana", "deepseek"] as const;

export interface ProviderDiscoveryContext {
  providerId: string;
  source: ProviderSource;
}

export type ProviderDiscoveryResult =
  | DiscoveredModel[]
  | DiscoveryReport
  | { outcome: "skipped"; reason: string };

export type ProviderDiscoveryAdapter = (
  context: ProviderDiscoveryContext,
) => Promise<ProviderDiscoveryResult>;

export type ProviderDiscoveryAdapterRegistry = Record<string, ProviderDiscoveryAdapter>;

export interface ConfigSyncProvidersResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

export interface RunConfigSyncProvidersOpts {
  apply?: boolean;
  dryRun?: boolean;
  configDir?: string;
  env?: Record<string, string | undefined>;
  discoveryAdapters?: ProviderDiscoveryAdapterRegistry;
  fetchModelsDevPayload?: () => Promise<unknown>;
  safetyGate?: typeof runGeneratorSafetyGate;
  reloadConfig?: () => Promise<unknown>;
  storageRoot?: string;
}

interface GeneratedSeat {
  agent: AgentConfig;
  alias: ModelAliasMap[string];
  identity: string;
  seatNameInput: SeatNameInput;
  managedFields: string[];
}

type HttpProviderBinding = ProviderBinding & { kind: "openai-compat-http" };
type LeafProviderBinding = ProviderBinding & { kind: "opencode-acp" };
type CarrierProviderBinding = ProviderBinding & { kind: "stdio-acp" | "agy-cli" };
type MaterializationStrategy = "http" | "leaf" | "carrier" | "unsupported";

function argsTemplateMissingModelCarrierPlaceholder(binding: ProviderBinding): boolean {
  if (binding.carriers?.args_template === undefined) return false;
  return !binding.carriers.args_template.some((token) => {
    if (token.includes("{model}")) return true;
    return binding.kind === "agy-cli" && token.includes("{displayName}");
  });
}

function resolveMaterializationStrategy(binding: ProviderBinding): MaterializationStrategy {
  switch (binding.kind) {
    case "openai-compat-http":
      return "http";
    case "opencode-acp":
      return "leaf";
    case "stdio-acp":
    case "agy-cli":
      return "carrier";
    case "cli":
      return "unsupported";
  }
}

function resolveConfigDir(env: Record<string, string | undefined>): string {
  if (env.PENUMBRA_CONFIG_DIR && env.PENUMBRA_CONFIG_DIR.length > 0) return env.PENUMBRA_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, "penumbra");
  }
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".config", "penumbra");
}

function readAgentsConfig(configDir: string): AgentsConfig {
  const path = join(configDir, "agents.yaml");
  return AgentsConfigSchema.parse(YAML.parse(readFileSync(path, "utf8")) as unknown);
}

function readRoutingConfig(configDir: string): RoutingConfig {
  const path = join(configDir, "routing.yaml");
  if (!existsSync(path)) return RoutingConfigSchema.parse({});
  return RoutingConfigSchema.parse(YAML.parse(readFileSync(path, "utf8")) as unknown);
}

function httpBaseUrl(locator: string): string {
  return locator.replace(/\/+models\/?$/i, "").replace(/\/+$/, "");
}

function skippedHttpResult(result: HttpModelDiscoveryResult): ProviderDiscoveryResult {
  return result.outcome === "discovered"
    ? result.models
    : { outcome: "skipped", reason: result.reason };
}

function isDiscoveryReport(result: ProviderDiscoveryResult): result is DiscoveryReport {
  return !Array.isArray(result) && result.outcome === "discovered";
}

function isSkippedDiscoveryResult(
  result: ProviderDiscoveryResult,
): result is { outcome: "skipped"; reason: string } {
  return (
    !Array.isArray(result) && result.outcome === "skipped" && typeof result.reason === "string"
  );
}

function validDiscoveryDiagnostics(diagnostics: unknown): DiscoveryDiagnostic[] {
  if (!Array.isArray(diagnostics)) return [];
  const valid: DiscoveryDiagnostic[] = [];
  for (const entry of diagnostics as unknown[]) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      "row" in entry &&
      "reason" in entry &&
      typeof entry.row === "string" &&
      typeof entry.reason === "string"
    ) {
      valid.push({
        row: entry.row,
        reason: entry.reason,
      });
    }
  }
  return valid;
}

function httpDiscoveryAdapter(): ProviderDiscoveryAdapter {
  return async ({ providerId, source }) => {
    if (!source.auth.keychain) {
      return {
        outcome: "skipped",
        reason: `${providerId} HTTP discovery requires auth.keychain`,
      };
    }
    return skippedHttpResult(
      await discoverHttpModels({
        provider: {
          providerId,
          baseUrl: httpBaseUrl(source.discovery.locator),
          keychainAccount: source.auth.keychain,
        },
      }),
    );
  };
}

export interface DefaultDiscoveryAdaptersOpts {
  acpSessionSpawn?: AcpSessionSpawner;
  acpSessionTimeoutMs?: number;
}

export function defaultDiscoveryAdapters(
  opts: DefaultDiscoveryAdaptersOpts = {},
): ProviderDiscoveryAdapterRegistry {
  const discoverHttp = httpDiscoveryAdapter();
  return {
    "acp-session": async ({ providerId, source }): Promise<ProviderDiscoveryResult> => {
      const [command, ...args] = source.discovery.locator.trim().split(/\s+/);
      if (!command) {
        return { outcome: "skipped", reason: "ACP session discovery locator is empty" };
      }
      // Discovery is source-wide, so union every binding's unset list. Removing more variables is
      // safer than probing under a principal that some generated seats deliberately exclude.
      const unsetEnv = [
        ...new Set(
          Object.values(source.bindings).flatMap((binding) => binding.carriers?.unset_env ?? []),
        ),
      ];
      return await discoverAcpSessionModels({
        providerId,
        command,
        args,
        ...(opts.acpSessionSpawn ? { spawn: opts.acpSessionSpawn } : {}),
        timeoutMs: opts.acpSessionTimeoutMs ?? 10_000,
        ...(unsetEnv.length > 0 ? { unsetEnv } : {}),
      });
    },
    codex: async () => await discoverCodexModels(),
    "codex-cli": async () => await discoverCodexModels(),
    agy: async () => await discoverAgyModels(),
    "agy-cli": async () => await discoverAgyModels(),
    opencode: async () => await discoverOpencodeModels(),
    "opencode-cli": async () => await discoverOpencodeModels(),
    http: discoverHttp,
    endpoint: discoverHttp,
  };
}

function carrierPath(carrier: string): string {
  return carrier.startsWith("options.") ? carrier : `options.${carrier}`;
}

const UNSAFE_MODEL_CARRIER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function modelCarrierSegments(path: string): string[] {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (segments.some((segment) => UNSAFE_MODEL_CARRIER_SEGMENTS.has(segment))) {
    throw new Error(`refusing unsafe model carrier ${JSON.stringify(path)}`);
  }
  return segments;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = modelCarrierSegments(path);
  const last = segments.pop();
  if (!last) throw new Error(`invalid model carrier ${JSON.stringify(path)}`);
  let cursor = target;
  for (const segment of segments) {
    const current = cursor[segment];
    const next =
      current !== null && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[last] = value;
}

function getPath(target: unknown, path: string): unknown {
  let cursor = target;
  for (const segment of modelCarrierSegments(path)) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function containsEmbeddedModelIdentity(value: unknown, modelId: string): boolean {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => {
      if (["model", "model_id", "modelId"].includes(key) && entry === modelId) return true;
      return containsEmbeddedModelIdentity(entry, modelId);
    });
  }
  if (typeof value !== "string") return false;
  try {
    return containsEmbeddedModelIdentity(JSON.parse(value) as unknown, modelId);
  } catch {
    const escaped = modelId.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\n,{])\\s*(?:model|model_id)\\s*[:=]\\s*["']${escaped}["']`).test(
      value,
    );
  }
}

function agentCarriesModel(
  agent: AgentConfig,
  modelId: string,
  modelCarrier: string,
  displayName?: string,
): boolean {
  const modelPath = carrierPath(modelCarrier);
  const configuredCarrier = getPath(agent, modelPath);
  if (configuredCarrier !== undefined) {
    return (
      configuredCarrier === modelId || containsEmbeddedModelIdentity(configuredCarrier, modelId)
    );
  }
  const carrierSegments = modelCarrierSegments(modelPath);
  const carrierName = carrierSegments.pop();
  const carrierParent = getPath(agent, carrierSegments.join("."));
  if (carrierName && Array.isArray(carrierParent)) {
    const candidates = [modelId, ...(displayName === undefined ? [] : [displayName])];
    if (
      candidates.some((candidate) =>
        carrierParent.some(
          (token, index) =>
            token === `${carrierName}=${candidate}` ||
            (token === `--${carrierName}` && carrierParent[index + 1] === candidate),
        ),
      )
    ) {
      return true;
    }
  }
  if (agent.options.model === modelId || agent.subscription_model === modelId) return true;
  return (
    modelCarrierSegments(modelPath).includes("CODEX_CONFIG") &&
    containsEmbeddedModelIdentity(agent.options.env?.CODEX_CONFIG, modelId)
  );
}

function renderSeatName(
  template: string,
  model: DiscoveredModel,
): {
  name: string;
  input: SeatNameInput;
} {
  if (!template.includes("{model}")) {
    throw new Error(`seat_name_template ${JSON.stringify(template)} must include {model}`);
  }
  const hasTierPlaceholder = template.includes("{tier}");
  const [rendered] = renderTemplateTokens(
    [template],
    {
      modelId: model.modelId,
      reasoningTier: model.reasoningTier,
      displayName: model.displayName,
    },
    { onMissingTier: "empty" },
  );
  const input: SeatNameInput = {
    source: "",
    modelSlug: rendered ?? "",
    ...(!hasTierPlaceholder && model.reasoningTier ? { effort: model.reasoningTier } : {}),
  };
  return { name: seatNameFor(input.source, input.modelSlug, input.effort), input };
}

function aliasSlug(model: DiscoveredModel): string {
  return seatNameFor("", model.modelId, model.reasoningTier);
}

function aliasCreator(model: DiscoveredModel, binding: ProviderBinding): string {
  const fromModelsDev = model.metadata?.modelsDevProvider;
  return typeof fromModelsDev === "string" && fromModelsDev.length > 0
    ? fromModelsDev
    : binding.api_provider;
}

function materializeHttpSeat(
  providerId: string,
  source: ProviderSource,
  bindingId: string,
  binding: HttpProviderBinding,
  model: DiscoveredModel,
): GeneratedSeat {
  const { name, input } = renderSeatName(binding.seat_name_template, model);
  const modelPath = carrierPath(binding.model_carrier);
  const options: Record<string, unknown> = {};
  setPath(options, modelPath.replace(/^options\./, ""), model.modelId);
  options.baseUrl = httpBaseUrl(source.discovery.locator);
  const carrierManagedFields = [modelPath, "options.baseUrl"];
  if (source.auth.keychain) {
    options.apiKeyKeychain = source.auth.keychain;
    carrierManagedFields.push("options.apiKeyKeychain");
  }
  const managedFields = [
    "name",
    "adapter",
    "api_provider",
    "pricing_mode",
    "subscription_provider",
    ...carrierManagedFields,
  ];

  return {
    identity: JSON.stringify([providerId, bindingId, model.modelId, model.reasoningTier ?? null]),
    seatNameInput: input,
    managedFields,
    agent: {
      name,
      adapter: binding.kind,
      api_provider: binding.api_provider,
      pricing_mode: binding.pricing_mode,
      ...(binding.subscription_provider
        ? { subscription_provider: binding.subscription_provider }
        : {}),
      // Roles on generated seats are the operator's promotion act and are deliberately outside managed_fields.
      roles: [],
      auto_approve_to: [],
      provenance: {
        source: PROVENANCE_SOURCE,
        managed_fields: managedFields,
      },
      options: options,
    },
    alias: {
      aa_creator: aliasCreator(model, binding),
      aa_slug: aliasSlug(model),
      ...(model.reasoningTier ? { reasoning_level: model.reasoningTier } : {}),
    },
  };
}

function materializeLeafSeat(
  providerId: string,
  bindingId: string,
  binding: LeafProviderBinding,
  model: DiscoveredModel,
): GeneratedSeat {
  const { name, input } = renderSeatName(binding.seat_name_template, model);
  const modelPath = carrierPath(binding.model_carrier);
  const baseOptions: Record<string, unknown> = {};
  setPath(baseOptions, modelPath.replace(/^options\./, ""), model.modelId);
  const applied = applyBindingCarriers(baseOptions, binding.carriers, binding.kind, {
    modelId: model.modelId,
    reasoningTier: model.reasoningTier,
    displayName: model.displayName,
  });
  const managedFields = [
    "name",
    "adapter",
    "api_provider",
    "pricing_mode",
    "subscription_provider",
    modelPath,
    ...applied.managedFields,
  ];

  return {
    identity: JSON.stringify([providerId, bindingId, model.modelId, model.reasoningTier ?? null]),
    seatNameInput: input,
    managedFields,
    agent: {
      name,
      adapter: binding.kind,
      api_provider: binding.api_provider,
      pricing_mode: binding.pricing_mode,
      ...(binding.subscription_provider
        ? { subscription_provider: binding.subscription_provider }
        : {}),
      ...applied.topLevel,
      roles: [],
      auto_approve_to: [],
      provenance: {
        source: PROVENANCE_SOURCE,
        managed_fields: managedFields,
      },
      options: applied.options,
    },
    alias: {
      aa_creator: aliasCreator(model, binding),
      aa_slug: aliasSlug(model),
      ...(model.reasoningTier ? { reasoning_level: model.reasoningTier } : {}),
    },
  };
}

function materializeCarrierSeat(
  providerId: string,
  bindingId: string,
  binding: CarrierProviderBinding,
  model: DiscoveredModel,
): GeneratedSeat {
  if (argsTemplateMissingModelCarrierPlaceholder(binding)) {
    throw new Error(
      binding.kind === "agy-cli"
        ? "carriers.args_template must include {model} or {displayName}"
        : "carriers.args_template must include {model}",
    );
  }
  const { name, input } = renderSeatName(binding.seat_name_template, model);
  const applied = applyBindingCarriers({}, binding.carriers, binding.kind, {
    modelId: model.modelId,
    reasoningTier: model.reasoningTier,
    displayName: model.displayName,
  });
  const managedFields = [
    "name",
    "adapter",
    "api_provider",
    "pricing_mode",
    "subscription_provider",
    ...applied.managedFields,
  ];

  return {
    identity: JSON.stringify([providerId, bindingId, model.modelId, model.reasoningTier ?? null]),
    seatNameInput: input,
    managedFields,
    agent: {
      name,
      adapter: binding.kind,
      api_provider: binding.api_provider,
      pricing_mode: binding.pricing_mode,
      ...(binding.subscription_provider
        ? { subscription_provider: binding.subscription_provider }
        : {}),
      ...applied.topLevel,
      roles: [],
      auto_approve_to: [],
      provenance: {
        source: PROVENANCE_SOURCE,
        managed_fields: managedFields,
      },
      options: applied.options,
    },
    alias: {
      aa_creator: aliasCreator(model, binding),
      aa_slug: aliasSlug(model),
      ...(model.reasoningTier ? { reasoning_level: model.reasoningTier } : {}),
    },
  };
}

async function defaultReloadConfig(storageRoot: string): Promise<unknown> {
  const portPath = join(storageRoot, "port");
  const tokenPath = join(storageRoot, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    return { skipped: "daemon metadata not found" };
  }
  const port = Number(readFileSync(portPath, "utf8").trim());
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length === 0) {
    return { skipped: "daemon metadata invalid" };
  }
  const response = await fetch(`http://127.0.0.1:${String(port)}/agentchat/reload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { skipped: `daemon reload returned HTTP ${String(response.status)}` };
  return await response.json();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the existing provider sync workflow while grandfathering its pre-existing complexity.
export async function runConfigSyncProviders( // eslint-disable-line max-lines-per-function -- Preserve the existing provider sync workflow while grandfathering its pre-existing size.
  opts: RunConfigSyncProvidersOpts = {},
): Promise<ConfigSyncProvidersResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env = opts.env ?? process.env;
  const configDir = opts.configDir ?? resolveConfigDir(env);
  const dryRun = opts.dryRun === true || opts.apply !== true;

  let current: AgentsConfig;
  let aliases: ModelAliasMap;
  let routing: RoutingConfig;
  let providerSources: ReturnType<typeof loadProviderSourcesFromDir>;
  try {
    current = readAgentsConfig(configDir);
    aliases = loadModelAliasMapFromDir(configDir);
    routing = readRoutingConfig(configDir);
    providerSources = loadProviderSourcesFromDir(configDir);
  } catch (error) {
    stderr.push(`penumbra config sync-providers: ${describeError(error)}`);
    return { exitCode: 1, stdout, stderr };
  }

  const providerEntries = Object.entries(providerSources);
  if (providerEntries.length === 0) {
    stdout.push("penumbra config sync-providers: no provider sources configured; unchanged");
    return { exitCode: 0, stdout, stderr };
  }

  const discoveryAdapters = opts.discoveryAdapters ?? defaultDiscoveryAdapters();
  const discoveredByProvider = new Map<string, DiscoveredModel[]>();
  let discoveryComplete = true;

  for (const [providerId, source] of providerEntries) {
    const kind = source.discovery.kind;
    const adapter = Object.hasOwn(discoveryAdapters, kind) ? discoveryAdapters[kind] : undefined;
    if (typeof adapter !== "function") {
      discoveryComplete = false;
      stdout.push(
        `provider ${providerId} skipped: no discovery adapter registered for kind ${JSON.stringify(kind)}`,
      );
      continue;
    }

    try {
      const result = await adapter({ providerId, source });
      if (isSkippedDiscoveryResult(result)) {
        discoveryComplete = false;
        stdout.push(`provider ${providerId} skipped: ${result.reason}`);
        continue;
      }
      if (!Array.isArray(result) && !isDiscoveryReport(result)) {
        discoveryComplete = false;
        stdout.push(
          `provider ${providerId} skipped: discovery adapter returned an invalid skipped reason`,
        );
        continue;
      }
      const models = Array.isArray(result) ? result : result.models;
      const diagnostics = Array.isArray(result)
        ? []
        : validDiscoveryDiagnostics(result.diagnostics);
      for (const diagnostic of diagnostics) {
        stdout.push(
          `provider ${providerId} malformed row skipped: ${JSON.stringify(diagnostic.row)} — ${diagnostic.reason}`,
        );
      }
      assertDiscoveryNotSuspiciouslyEmpty(models);
      const includedModelIds = source.include_models ? new Set(source.include_models) : undefined;
      const excludedModelIds = new Set(source.exclude_models ?? []);
      const discoveredModelIds = new Set(models.map((model) => model.modelId));
      let included = includedModelIds
        ? models.filter((model) => includedModelIds.has(model.modelId))
        : models;
      if (includedModelIds) {
        if (included.length === 0) {
          discoveryComplete = false;
          stdout.push(
            `include_models matched 0 of ${String(models.length)} discovered models for ${providerId} — refusing to generate or prune; fix the list`,
          );
          continue;
        }
        stdout.push(
          `include_models: kept ${String(included.length)} of ${String(models.length)} discovered models`,
        );
        for (const entry of source.include_models ?? []) {
          if (!discoveredModelIds.has(entry)) {
            stdout.push(`inclusion unmatched (stale): ${providerId}/${entry}`);
          }
        }
      }
      included = included.filter((model) => {
        if (!excludedModelIds.has(model.modelId)) return true;
        stdout.push(`model excluded by config: ${providerId}/${model.modelId}`);
        return false;
      });
      for (const entry of source.exclude_models ?? []) {
        if (!discoveredModelIds.has(entry)) {
          stdout.push(`exclusion unmatched (stale): ${providerId}/${entry}`);
        }
      }
      discoveredByProvider.set(
        providerId,
        included.map((model) => ({ ...model, sourceProviderId: providerId })),
      );
    } catch (error) {
      discoveryComplete = false;
      stdout.push(`provider ${providerId} skipped: ${describeError(error)}`);
    }
  }

  const allDiscovered = [...discoveredByProvider.values()].flat();
  let enriched = allDiscovered;
  if (allDiscovered.length > 0) {
    try {
      const payload = await (opts.fetchModelsDevPayload ?? fetchModelsDevPayload)();
      enriched = joinModelsDevMetadata(allDiscovered, payload);
    } catch (error) {
      stdout.push(`models.dev metadata skipped: ${describeError(error)}`);
    }
  }

  const enrichedByProvider = new Map<string, DiscoveredModel[]>();
  for (const model of enriched) {
    const group = enrichedByProvider.get(model.sourceProviderId);
    if (group) group.push(model);
    else enrichedByProvider.set(model.sourceProviderId, [model]);
  }

  const manualAgents = current.agents.filter(
    (agent) => agent.provenance?.source !== PROVENANCE_SOURCE,
  );
  const generated: GeneratedSeat[] = [];
  const reportedHandCoverage = new Set<string>();
  const reportedEdges = new Map<string, { stdoutIndex: number; tiers: string[] }>();

  try {
    for (const [providerId, source] of providerEntries) {
      const models = enrichedByProvider.get(providerId) ?? [];
      const unusableBindingIds = new Set<string>();
      for (const [bindingId, binding] of Object.entries(source.bindings)) {
        if (binding.kind === "stdio-acp" && argsTemplateMissingModelCarrierPlaceholder(binding)) {
          stdout.push(
            `binding unusable: ${providerId}/${bindingId} — carriers.args_template must include {model}`,
          );
          unusableBindingIds.add(bindingId);
        }
      }
      for (const model of models) {
        for (const [bindingId, binding] of Object.entries(source.bindings)) {
          const handCovered = manualAgents.some(
            (agent) =>
              agent.api_provider === binding.api_provider &&
              agentCarriesModel(agent, model.modelId, binding.model_carrier, model.displayName),
          );
          if (handCovered) {
            const coverageKey = `${binding.api_provider}/${model.modelId}`;
            if (!reportedHandCoverage.has(coverageKey)) {
              reportedHandCoverage.add(coverageKey);
              stdout.push(`hand-covered ${coverageKey}`);
            }
            continue;
          }
          if (unusableBindingIds.has(bindingId)) continue;
          const strategy = resolveMaterializationStrategy(binding);
          if (strategy === "unsupported" || (strategy === "carrier" && !binding.carriers?.binary)) {
            const edgeKey = JSON.stringify([binding.api_provider, model.modelId, bindingId]);
            const reportedEdge = reportedEdges.get(edgeKey);
            const tiers = reportedEdge?.tiers ?? [];
            if (model.reasoningTier && !tiers.includes(model.reasoningTier)) {
              tiers.push(model.reasoningTier);
            }
            const line = `edge lit (no seat): ${binding.api_provider}/${model.modelId}${tiers.length > 0 ? ` [${tiers.join(",")}]` : ""} via ${bindingId} — seat generation for kind ${binding.kind} requires the P5 binding contract (binary/tier/env carriers)${strategy === "carrier" ? ": missing carriers.binary" : ""}`;
            if (reportedEdge) {
              stdout[reportedEdge.stdoutIndex] = line;
            } else {
              reportedEdges.set(edgeKey, { stdoutIndex: stdout.length, tiers });
              stdout.push(line);
            }
            continue;
          }
          if (strategy === "http") {
            if (binding.kind !== "openai-compat-http") {
              throw new Error(
                `internal materialization strategy mismatch for kind ${binding.kind}`,
              );
            }
            generated.push(
              materializeHttpSeat(
                providerId,
                source,
                bindingId,
                binding as HttpProviderBinding,
                model,
              ),
            );
            continue;
          }
          if (strategy === "carrier") {
            if (binding.kind !== "stdio-acp" && binding.kind !== "agy-cli") {
              throw new Error(
                `internal materialization strategy mismatch for kind ${binding.kind}`,
              );
            }
            try {
              generated.push(
                materializeCarrierSeat(
                  providerId,
                  bindingId,
                  binding as CarrierProviderBinding,
                  model,
                ),
              );
            } catch (error) {
              stdout.push(
                `edge lit (no seat): ${binding.api_provider}/${model.modelId}${model.reasoningTier ? ` [${model.reasoningTier}]` : ""} via ${bindingId} — ${describeError(error)}`,
              );
            }
            continue;
          }
          if (binding.kind !== "opencode-acp") {
            throw new Error(`internal materialization strategy mismatch for kind ${binding.kind}`);
          }
          generated.push(
            materializeLeafSeat(providerId, bindingId, binding as LeafProviderBinding, model),
          );
        }
      }
    }
  } catch (error) {
    stderr.push(`penumbra config sync-providers: ${describeError(error)}`);
    return { exitCode: 1, stdout, stderr };
  }

  const uniqueGeneratedByName = new Map<string, GeneratedSeat>();
  for (const seat of generated) {
    const existing = uniqueGeneratedByName.get(seat.agent.name);
    if (existing && existing.identity !== seat.identity) {
      stderr.push(
        `penumbra config sync-providers: generated seat name ${seat.agent.name} collides across distinct binding/model/tier identities`,
      );
      return { exitCode: 1, stdout, stderr };
    }
    uniqueGeneratedByName.set(seat.agent.name, seat);
  }
  const uniqueGenerated = [...uniqueGeneratedByName.values()];
  const byName = new Map(current.agents.map((agent) => [agent.name, agent] as const));
  const generatedNames = new Set<string>();
  const candidateAliases: Record<string, ModelAliasMap[string]> = { ...aliases };
  const agentUpserts: string[] = [];
  const aliasUpserts: string[] = [];

  try {
    for (const seat of uniqueGenerated) {
      const existing = byName.get(seat.agent.name);
      if (existing && existing.provenance?.source !== PROVENANCE_SOURCE) {
        throw new Error(
          `generated seat ${seat.agent.name} collides with a hand-authored seat of the same name`,
        );
      }
      const upserted = {
        ...upsertManagedFields(existing, seat.agent, seat.managedFields),
        provenance: seat.agent.provenance,
      };
      if (!isDeepStrictEqual(existing, upserted)) agentUpserts.push(seat.agent.name);
      if (!isDeepStrictEqual(aliases[seat.agent.name], seat.alias)) {
        aliasUpserts.push(seat.agent.name);
        if (
          Object.hasOwn(aliases, seat.agent.name) &&
          existing?.provenance?.source !== PROVENANCE_SOURCE
        ) {
          stderr.push(
            `penumbra config sync-providers: warning: overwriting non-generated model alias ${seat.agent.name}`,
          );
        }
      }
      byName.set(seat.agent.name, upserted);
      generatedNames.add(seat.agent.name);
      candidateAliases[seat.agent.name] = seat.alias;
    }
  } catch (error) {
    stderr.push(`penumbra config sync-providers: ${describeError(error)}`);
    return { exitCode: 1, stdout, stderr };
  }

  const pruneResult = discoveryComplete
    ? pruneOwnedOnly([...byName.values()], generatedNames, PROVENANCE_SOURCE)
    : { agents: [...byName.values()], prunes: [] };
  for (const name of pruneResult.prunes) Reflect.deleteProperty(candidateAliases, name);
  if (!discoveryComplete) {
    stdout.push("penumbra config sync-providers: discovery incomplete; skipping prune step");
  }

  let candidateConfig: AgentsConfig;
  let aliasMap: ModelAliasMap;
  try {
    candidateConfig = AgentsConfigSchema.parse({ ...current, agents: pruneResult.agents });
    aliasMap = ModelAliasMapSchema.parse(candidateAliases);
  } catch (error) {
    stderr.push(
      `penumbra config sync-providers: schema validation failed: ${describeError(error)}`,
    );
    return { exitCode: 1, stdout, stderr };
  }

  const safetyGate = opts.safetyGate ?? runGeneratorSafetyGate;
  const gateResult: GeneratorSafetyGateResult = safetyGate(candidateConfig, {
    allowedProviders: ALLOWED_BILLED_HTTP_PROVIDERS,
    generatorSource: PROVENANCE_SOURCE,
    aliasMap,
    roleTags: [...new Set(candidateConfig.agents.flatMap((agent) => agent.roles))],
    seatNameInputs: uniqueGenerated.map((seat) => seat.seatNameInput),
    candidatePrunes: pruneResult.prunes,
    routing,
  });
  stdout.push(...gateResult.warnings.map((warning) => `warning: ${warning}`));
  if (!gateResult.ok) {
    stderr.push("penumbra config sync-providers: safety gate failed");
    stderr.push(...gateResult.violations.map((violation) => `  - ${violation}`));
    return { exitCode: 1, stdout, stderr };
  }

  for (const name of agentUpserts) stdout.push(`${dryRun ? "would upsert" : "upserted"} ${name}`);
  for (const name of aliasUpserts) stdout.push(`${dryRun ? "would alias" : "aliased"} ${name}`);
  for (const name of pruneResult.prunes) {
    stdout.push(`${dryRun ? "would prune" : "pruned"} ${name}`);
  }

  if (dryRun) {
    stdout.push(
      "penumbra config sync-providers: dry run; pass --apply to write agents.yaml and model-aliases.yaml",
    );
    return { exitCode: 0, stdout, stderr };
  }

  const writeCode = executeConfigSplitWrite(
    [
      ["agents.yaml", candidateConfig],
      ["model-aliases.yaml", aliasMap],
    ],
    [],
    configDir,
  );
  if (writeCode !== 0) return { exitCode: writeCode, stdout, stderr };

  try {
    const reload = await (
      opts.reloadConfig ??
      ((): Promise<unknown> =>
        defaultReloadConfig(
          resolveDaemonStorageRoot({ explicit: opts.storageRoot ?? env.PENUMBRA_STORAGE_ROOT }),
        ))
    )();
    if (
      reload &&
      typeof reload === "object" &&
      "skipped" in reload &&
      typeof reload.skipped === "string"
    ) {
      stdout.push(`penumbra config sync-providers: daemon reload skipped: ${reload.skipped}`);
    } else {
      stdout.push("penumbra config sync-providers: daemon reload requested");
    }
  } catch (error) {
    stdout.push(`penumbra config sync-providers: daemon reload skipped: ${describeError(error)}`);
  }

  return { exitCode: 0, stdout, stderr };
}
