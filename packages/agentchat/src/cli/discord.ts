import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config/load.js";
import { type DiscordNotificationEvent, renderDiscordEvent } from "../worker/discord-events.js";
import { type DiscordFetch, postToDiscord } from "../worker/discord-notifier.js";
import { loadNotificationConfig } from "../worker/notification-config.js";
import { resolveNotificationRoute } from "../worker/notification-router.js";

export interface DiscordCliDeps {
  env: Record<string, string | undefined>;
  fetch: DiscordFetch;
}

function getConfigPath(env: Record<string, string | undefined>): string {
  return env.AGENTCHAT_CONFIG ?? join(homedir(), ".config/agentchat/agentchat.yaml");
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function isDiscordWebhookUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.pathname.includes("/api/webhooks/") || url.pathname.includes("/webhooks/"))
    );
  } catch {
    return false;
  }
}

function buildSampleEvent(input: {
  kind: DiscordNotificationEvent["kind"];
  projectId: string;
  agent: string;
  prompt?: string;
}): DiscordNotificationEvent {
  const base = {
    kind: input.kind,
    project_id: input.projectId,
    handoff_id: "h-sample",
    conversation_id: "c-sample",
    agent: input.agent,
    worker_id: "worker-sample",
    provider: "provider-sample",
    model: "model-sample",
    prompt: input.prompt,
  } as const;

  switch (input.kind) {
    case "dispatch_start":
      return { ...base, kind: "dispatch_start", status: "started" };
    case "dispatch_end":
      return {
        ...base,
        kind: "dispatch_end",
        status: "completed",
        latency_seconds: 12,
      };
    case "dispatch_failure":
      return {
        ...base,
        kind: "dispatch_failure",
        status: "failed",
        error_summary: "sample dispatch failure",
      };
    case "watchdog_failure":
      return {
        ...base,
        kind: "watchdog_failure",
        error_summary: "sample watchdog failure",
      };
    case "claim_retry":
      return {
        ...base,
        kind: "claim_retry",
        attempt: 2,
        max_attempts: 3,
        error_summary: "sample retry",
      };
    case "adapter_retry_exhausted":
      return {
        ...base,
        kind: "adapter_retry_exhausted",
        attempt: 3,
        max_attempts: 3,
        error_summary: "sample exhaustion",
      };
    case "autocommit_on_chain_end":
      return {
        ...base,
        kind: "autocommit_on_chain_end",
        error_summary: "sample autocommit failed",
      };
    case "permission_requested":
      return {
        ...base,
        kind: "permission_requested",
        permission_id: "p-sample",
        tool_name: "functions.exec_command",
        ttl_at: "2026-05-02T12:00:00.000Z",
      };
    case "permission_decided":
      return {
        ...base,
        kind: "permission_decided",
        permission_id: "p-sample",
        tool_name: "functions.exec_command",
        decision: "approve",
        decided_by: "operator",
      };
    case "permission_expired":
      return {
        ...base,
        kind: "permission_expired",
        permission_id: "p-sample",
        tool_name: "functions.exec_command",
        ttl_at: "2026-05-02T12:00:00.000Z",
      };
    case "merge_result":
      return {
        ...base,
        kind: "merge_result",
        status: "pr_opened",
        pr_url: "https://example.test/pr/1",
      };
    case "cost_quota_summary":
      return {
        ...base,
        kind: "cost_quota_summary",
        status: "warning",
        period: "24h",
        total_cost_usd: 12.34,
        budget_usd: 20,
        usage_summary: "sample usage summary",
      };
    default: {
      const exhaustive: never = input.kind;
      throw new Error(`unsupported sample event kind: ${String(exhaustive)}`);
    }
  }
}

function collectReferencedEnvNames(
  notifications: ReturnType<typeof loadNotificationConfig>,
): Set<string> {
  const names = new Set<string>();
  for (const channel of Object.values(notifications.channels)) {
    if (channel?.defaultWebhookUrlEnv) names.add(channel.defaultWebhookUrlEnv);
  }
  for (const route of Object.values(notifications.routes.projects)) {
    if (route.webhookUrlEnv) names.add(route.webhookUrlEnv);
  }
  return names;
}

function printRouteStatus(
  notifications: ReturnType<typeof loadNotificationConfig>,
  env: Record<string, string | undefined>,
): void {
  const defaultRoute = resolveNotificationRoute({ config: notifications, env });
  process.stdout.write(`default: ${defaultRoute ? "configured" : "missing"}\n`);

  for (const projectId of Object.keys(notifications.routes.projects).sort()) {
    const route = resolveNotificationRoute({ config: notifications, env, projectId });
    process.stdout.write(`project ${projectId}: ${route ? "configured" : "missing"}\n`);
  }
}

function reportEnvStatus(
  referencedEnvNames: ReadonlySet<string>,
  env: Record<string, string | undefined>,
): boolean {
  let hasMissingEnv = false;
  for (const name of [...referencedEnvNames].sort()) {
    const value = env[name];
    if (!value) {
      hasMissingEnv = true;
      process.stdout.write(`env ${name}: unset\n`);
    } else if (!isDiscordWebhookUrl(value)) {
      hasMissingEnv = true;
      process.stdout.write(`env ${name}: invalid\n`);
    }
  }
  return hasMissingEnv;
}

function validateCommand(env: Record<string, string | undefined>): number {
  const config = loadConfig(getConfigPath(env));
  const notifications = loadNotificationConfig({ agentchat: config, env });
  const referencedEnvNames = collectReferencedEnvNames(notifications);

  printRouteStatus(notifications, env);
  const hasMissingEnv = reportEnvStatus(referencedEnvNames, env);

  return hasMissingEnv ? 1 : 0;
}

function renderCommand(args: string[], deps: DiscordCliDeps): number {
  const kind = readFlag(args, "--event") as DiscordNotificationEvent["kind"] | undefined;
  const projectId = readFlag(args, "--project-id");
  const agent = readFlag(args, "--agent");
  const prompt = readFlag(args, "--prompt");
  if (!kind || !projectId || !agent) {
    console.error(
      "usage: agentchat discord render --event <kind> --project-id <id> --agent <name> [--prompt <text>]",
    );
    return 1;
  }

  const config = loadConfig(getConfigPath(deps.env));
  const notifications = loadNotificationConfig({ agentchat: config, env: deps.env });
  const route = resolveNotificationRoute({
    config: notifications,
    env: deps.env,
    projectId,
    agentKey: agent,
  });
  if (!route) return 1;

  const payload = renderDiscordEvent(buildSampleEvent({ kind, projectId, agent, prompt }), {
    promptPolicy: route.promptPolicy,
  });
  process.stdout.write(`${JSON.stringify({ route_key: route.routeKey, payload })}\n`);
  return 0;
}

async function testCommand(args: string[], deps: DiscordCliDeps): Promise<number> {
  const projectId = readFlag(args, "--project-id");
  const agent = readFlag(args, "--agent");
  if (!projectId || !agent) {
    console.error("usage: agentchat discord test --project-id <id> --agent <name>");
    return 1;
  }

  const config = loadConfig(getConfigPath(deps.env));
  const notifications = loadNotificationConfig({ agentchat: config, env: deps.env });
  const route = resolveNotificationRoute({
    config: notifications,
    env: deps.env,
    projectId,
    agentKey: agent,
  });
  if (!route) return 1;

  const payload = renderDiscordEvent(buildSampleEvent({ kind: "dispatch_end", projectId, agent }), {
    promptPolicy: route.promptPolicy,
  });
  const ok = await postToDiscord(route.webhookUrl, payload, deps.fetch, undefined, route.identity);
  return ok ? 0 : 1;
}

export async function runDiscordCli(args: string[], deps: DiscordCliDeps): Promise<number> {
  try {
    const cmd = args[0];
    if (cmd === "validate") return validateCommand(deps.env);
    if (cmd === "render") return renderCommand(args.slice(1), deps);
    if (cmd === "test") return await testCommand(args.slice(1), deps);
    console.error("usage: agentchat discord <validate|render|test> [args]");
    return 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
