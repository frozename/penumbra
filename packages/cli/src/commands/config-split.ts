import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentChatConfigSchema } from "@penumbra/agentchat/config/types";
import { AgentsConfigSchema, QuotasConfigSchema, RoutingConfigSchema } from "@penumbra/config";
import type { AgentChatConfig } from "@penumbra/agentchat/config/types";

export interface ConfigSplitOpts {
  source?: string;
  sourceDir?: string;
  dest?: string;
  force?: boolean;
  dryRun?: boolean;
}

const LEGACY_OPERATOR_CONFIG_FILES = ["projects.yaml", "workers.yaml"] as const;

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

function countYamlLines(serialized: string): number {
  return serialized.endsWith("\n")
    ? serialized.slice(0, -1).split("\n").length
    : serialized.split("\n").length;
}

function normalizeLegacyShape(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...input };

  const reviewPersonas = input.review_personas;
  if (Array.isArray(reviewPersonas)) {
    normalized.review_personas = Object.fromEntries(
      reviewPersonas
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map((name) => [name, { name, bias: name, system_prompt: name, preferred_agent: name }]),
    );
  }

  const plannerPersonas = input.planner_personas;
  if (Array.isArray(plannerPersonas)) {
    normalized.planner_personas = Object.fromEntries(
      plannerPersonas
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map((name) => [name, { name, bias: name, system_prompt: name, preferred_agent: name }]),
    );
  }

  if (typeof input.review_synthesizer === "string") {
    normalized.review_synthesizer = {
      preferred_agent: input.review_synthesizer,
      system_prompt: input.review_synthesizer,
    };
  }

  if (typeof input.plan_synthesizer === "string") {
    normalized.plan_synthesizer = {
      preferred_agent: input.plan_synthesizer,
      system_prompt: input.plan_synthesizer,
    };
  }

  return normalized;
}

function splitLegacyConfig(source: AgentChatConfig) {
  const legacy = source as AgentChatConfig;

  const reviewWorkload = legacy.review_personas
    ? {
        eligible_roles: ["reviewer"],
        eligible_agents: Object.keys(legacy.review_personas),
        fan_out: Object.keys(legacy.review_personas).length,
        synthesizer: legacy.review_synthesizer?.preferred_agent,
      }
    : undefined;
  const planWorkload = legacy.planner_personas
    ? {
        eligible_roles: ["planner"],
        eligible_agents: Object.keys(legacy.planner_personas),
        fan_out: Object.keys(legacy.planner_personas).length,
        synthesizer: legacy.plan_synthesizer?.preferred_agent,
      }
    : undefined;

  const agents = AgentsConfigSchema.parse({
    agents: legacy.agents,
    thoughts: legacy.thoughts,
    shell: legacy.shell,
  });

  const workloads: Record<string, unknown> = {};
  if (reviewWorkload && reviewWorkload.eligible_agents.length > 0) {
    workloads.review_adversarial = reviewWorkload;
  }
  if (planWorkload && planWorkload.eligible_agents.length > 0) {
    workloads.plan_refine = planWorkload;
  }

  const routing = RoutingConfigSchema.parse({
    default_roles: legacy.default_roles,
    role_routing: legacy.role_routing,
    ...(Object.keys(workloads).length > 0 ? { workloads } : {}),
  });

  const quotas = QuotasConfigSchema.parse({ providers: legacy.providers });
  return { agents, routing, quotas };
}

export async function runConfigSplit(opts: ConfigSplitOpts): Promise<number> {
  const source =
    opts.source ?? (opts.sourceDir ? join(opts.sourceDir, "agentchat.yaml") : undefined);
  if (!source || !opts.dest) {
    console.error(
      "usage: penumbra config split (--source <path> | --source-dir <dir>) --dest <dir> [--force] [--dry-run]",
    );
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(source, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`penumbra config split: failed to read source ${source}: ${message}`);
    return 1;
  }

  const legacy = AgentChatConfigSchema.safeParse(normalizeLegacyShape(parsed));
  if (!legacy.success) {
    const message = legacy.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.error(`penumbra config split: invalid source config\n${message}`);
    return 1;
  }

  const { agents, routing, quotas } = splitLegacyConfig(legacy.data);
  const dest = opts.dest;
  const targets = [
    ["agents.yaml", agents],
    ["routing.yaml", routing],
    ["quotas.yaml", quotas],
  ] as const;
  const copyTargets: Array<{
    filename: (typeof LEGACY_OPERATOR_CONFIG_FILES)[number];
    sourcePath: string;
    destPath: string;
  }> = [];
  if (opts.sourceDir) {
    for (const filename of LEGACY_OPERATOR_CONFIG_FILES) {
      const sourcePath = join(opts.sourceDir, filename);
      if (!existsSync(sourcePath)) continue;
      copyTargets.push({ filename, sourcePath, destPath: join(dest, filename) });
    }
  }

  if (
    !opts.force &&
    (targets.some(([name]) => existsSync(join(dest, name))) ||
      copyTargets.some((target) => existsSync(target.destPath)))
  ) {
    console.error(
      "penumbra config split: destination already populated; pass --force to overwrite",
    );
    return 1;
  }

  if (opts.dryRun) {
    for (const [name, value] of targets) {
      const serialized = stringifyYaml(sortValue(value));
      process.stdout.write(
        `would write ${join(dest, name)} (${countYamlLines(serialized)} lines)\n`,
      );
    }
    for (const target of copyTargets) {
      process.stdout.write(`would copy ${target.sourcePath} -> ${target.destPath}\n`);
    }
    return 0;
  }

  try {
    mkdirSync(dest, { recursive: true });
    for (const [name, value] of targets) {
      const serialized = stringifyYaml(sortValue(value));
      writeFileSync(join(dest, name), serialized, "utf8");
    }
    for (const target of copyTargets) {
      copyFileSync(target.sourcePath, target.destPath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`penumbra config split: write failed: ${message}`);
    return 1;
  }

  return 0;
}
