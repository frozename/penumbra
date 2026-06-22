import type { DiscordEmbed, DiscordEmbedsPayload, DiscordField } from "./discord-notifier.js";

const COLOR_GREEN = 0x00cc66;
const COLOR_RED = 0xcc0000;
const COLOR_YELLOW = 0xcc9900;
const COLOR_BLUE = 0x3366cc;

type PromptPolicy = "never" | "summary" | "always";

interface EventBase {
  kind:
    | "dispatch_start"
    | "dispatch_end"
    | "dispatch_failure"
    | "watchdog_failure"
    | "claim_retry"
    | "adapter_retry_exhausted"
    | "autocommit_on_chain_end"
    | "permission_requested"
    | "permission_decided"
    | "permission_expired"
    | "merge_result"
    | "cost_quota_summary";
  project_id?: string;
  handoff_id?: string;
  conversation_id?: string;
  agent?: string;
  worker_id?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  pr_url?: string;
}

export type DiscordNotificationEvent =
  | (EventBase & {
      kind: "dispatch_start";
      status?: "started";
    })
  | (EventBase & {
      kind: "dispatch_end";
      status: "completed" | "failed" | "rejected" | "expired";
      latency_seconds?: number;
      error_summary?: string;
    })
  | (EventBase & {
      kind: "dispatch_failure";
      error_summary: string;
      status?: "failed";
    })
  | (EventBase & {
      kind: "watchdog_failure";
      error_summary: string;
    })
  | (EventBase & {
      kind: "claim_retry";
      attempt?: number;
      max_attempts?: number;
      error_summary?: string;
    })
  | (EventBase & {
      kind: "adapter_retry_exhausted";
      attempt?: number;
      max_attempts?: number;
      error_summary?: string;
    })
  | (EventBase & {
      kind: "autocommit_on_chain_end";
      error_summary?: string;
    })
  | (EventBase & {
      kind: "permission_requested";
      permission_id: string;
      tool_name: string;
      ttl_at?: string;
      decision?: never;
      raw_input?: never;
    })
  | (EventBase & {
      kind: "permission_decided";
      permission_id: string;
      tool_name?: string;
      decision: "approve" | "reject";
      decided_by?: string;
    })
  | (EventBase & {
      kind: "permission_expired";
      permission_id: string;
      tool_name?: string;
      ttl_at?: string;
    })
  | (EventBase & {
      kind: "merge_result";
      status: "verified" | "pr_opened" | "pr_creation_failed" | "typecheck_failed" | "test_failed";
      regression_summary?: string;
    })
  | (EventBase & {
      kind: "cost_quota_summary";
      status?: "ok" | "warning" | "critical";
      period?: string;
      total_cost_usd?: number;
      budget_usd?: number;
      usage_summary?: string;
    });

export interface RenderDiscordEventOptions {
  promptPolicy: PromptPolicy;
}

function truncate(value: string, max = 1024): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function maybePush(
  fields: DiscordField[],
  name: string,
  value: string | number | undefined,
  inline = false,
): void {
  if (value === undefined || value === "") return;
  fields.push({ name, value: truncate(String(value)), inline });
}

function renderPrompt(prompt: string, promptPolicy: PromptPolicy): string | undefined {
  if (promptPolicy === "never") return undefined;
  if (promptPolicy === "summary") return truncate(prompt, 200);
  return truncate(prompt);
}

function colorForEvent(event: DiscordNotificationEvent): number {
  switch (event.kind) {
    case "dispatch_end":
      if (event.status === "completed") return COLOR_GREEN;
      if (event.status === "expired") return COLOR_YELLOW;
      return COLOR_RED;
    case "dispatch_failure":
    case "watchdog_failure":
    case "adapter_retry_exhausted":
    case "merge_result":
      return event.kind === "merge_result" &&
        (event.status === "pr_opened" || event.status === "verified")
        ? COLOR_GREEN
        : COLOR_RED;
    case "claim_retry":
    case "permission_requested":
    case "permission_expired":
    case "cost_quota_summary":
    case "autocommit_on_chain_end":
      return COLOR_YELLOW;
    case "permission_decided":
      return event.decision === "approve" ? COLOR_GREEN : COLOR_RED;
    case "dispatch_start":
      return COLOR_BLUE;
  }
}

function titleForEvent(event: DiscordNotificationEvent): string {
  switch (event.kind) {
    case "dispatch_start":
      return "dispatch started";
    case "dispatch_end":
      return `dispatch ${event.status}`;
    case "dispatch_failure":
      return "dispatch failure";
    case "watchdog_failure":
      return "watchdog failure";
    case "claim_retry":
      return "claim retry";
    case "adapter_retry_exhausted":
      return "adapter retry exhausted";
    case "autocommit_on_chain_end":
      return "autocommit on chain end";
    case "permission_requested":
      return "permission requested";
    case "permission_decided":
      return `permission ${event.decision === "approve" ? "approved" : "rejected"}`;
    case "permission_expired":
      return "permission expired";
    case "merge_result":
      return `merge result ${event.status}`;
    case "cost_quota_summary":
      return "cost quota summary";
  }
}

function baseFields(event: DiscordNotificationEvent): DiscordField[] {
  const fields: DiscordField[] = [];
  maybePush(fields, "project", event.project_id);
  maybePush(fields, "agent", event.agent, true);
  maybePush(fields, "handoff", event.handoff_id);
  maybePush(fields, "conversation", event.conversation_id);
  maybePush(fields, "worker", event.worker_id, true);
  maybePush(fields, "provider", event.provider, true);
  maybePush(fields, "model", event.model, true);
  maybePush(fields, "pr", event.pr_url);
  return fields;
}

function attemptString(attempt: number, maxAttempts: number | undefined): string {
  const denom = maxAttempts === undefined ? "?" : String(maxAttempts);
  return `${String(attempt)}/${denom}`;
}

function appendKindFields(event: DiscordNotificationEvent, fields: DiscordField[]): void {
  switch (event.kind) {
    case "dispatch_start":
      maybePush(fields, "status", event.status ?? "started", true);
      return;
    case "dispatch_end":
      maybePush(fields, "status", event.status, true);
      maybePush(
        fields,
        "latency",
        event.latency_seconds === undefined ? undefined : `${String(event.latency_seconds)}s`,
        true,
      );
      maybePush(fields, "error", event.error_summary);
      return;
    case "dispatch_failure":
    case "watchdog_failure":
      maybePush(fields, "status", "failed", true);
      maybePush(fields, "error", event.error_summary);
      return;
    case "claim_retry":
      maybePush(fields, "status", "retrying", true);
      maybePush(
        fields,
        "attempt",
        event.attempt === undefined ? undefined : attemptString(event.attempt, event.max_attempts),
        true,
      );
      maybePush(fields, "error", event.error_summary);
      return;
    case "adapter_retry_exhausted":
      maybePush(fields, "status", "exhausted", true);
      maybePush(
        fields,
        "attempt",
        event.attempt === undefined
          ? undefined
          : attemptString(event.attempt, event.max_attempts ?? event.attempt),
        true,
      );
      maybePush(fields, "error", event.error_summary);
      return;
    case "autocommit_on_chain_end":
      maybePush(fields, "status", "autocommit", true);
      maybePush(fields, "error", event.error_summary);
      return;
    case "permission_requested":
      maybePush(fields, "status", "requested", true);
      maybePush(fields, "permission", event.permission_id);
      maybePush(fields, "tool", event.tool_name);
      maybePush(fields, "expires", event.ttl_at);
      return;
    case "permission_decided":
      maybePush(fields, "status", event.decision, true);
      maybePush(fields, "permission", event.permission_id);
      maybePush(fields, "tool", event.tool_name);
      maybePush(fields, "decided_by", event.decided_by);
      return;
    case "permission_expired":
      maybePush(fields, "status", "expired", true);
      maybePush(fields, "permission", event.permission_id);
      maybePush(fields, "tool", event.tool_name);
      maybePush(fields, "expires", event.ttl_at);
      return;
    case "merge_result":
      maybePush(fields, "status", event.status, true);
      maybePush(fields, "error", event.regression_summary);
      return;
    case "cost_quota_summary":
      maybePush(fields, "status", event.status ?? "summary", true);
      maybePush(fields, "period", event.period);
      maybePush(fields, "cost_usd", event.total_cost_usd);
      maybePush(fields, "budget_usd", event.budget_usd);
      maybePush(fields, "summary", event.usage_summary);
      return;
  }
}

export function renderDiscordEvent(
  event: DiscordNotificationEvent,
  options: RenderDiscordEventOptions,
): DiscordEmbedsPayload {
  const fields = baseFields(event);
  appendKindFields(event, fields);

  const prompt = event.prompt ? renderPrompt(event.prompt, options.promptPolicy) : undefined;
  if (prompt) {
    maybePush(fields, options.promptPolicy === "summary" ? "prompt_summary" : "prompt", prompt);
  }

  const embed: DiscordEmbed = {
    title: titleForEvent(event),
    color: colorForEvent(event),
    fields,
    timestamp: new Date().toISOString(),
  };

  return { embeds: [embed] };
}
