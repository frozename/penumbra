export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color: number;
  fields: DiscordField[];
  timestamp?: string;
}

export interface DiscordEmbedsPayload {
  embeds: DiscordEmbed[];
}

export interface DiscordWebhookIdentity {
  username?: string;
  avatar_url?: string;
}

export type DiscordFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HandoffNotificationContext {
  handoff_id: string;
  agent: string;
  status: "completed" | "failed" | "rejected" | "expired";
  latency_seconds: number;
  conversation_id: string;
  error_summary?: string;
  prompt?: string;
  pr_url?: string;
}

export interface MergeResultNotificationContext {
  handoff_id: string;
  conversation_id: string;
  agent: string;
  status: "verified" | "pr_opened" | "pr_creation_failed" | "typecheck_failed" | "test_failed";
  regression_summary?: string;
  prompt?: string;
  pr_url?: string;
}

const COLOR_GREEN = 0x00cc66;
const COLOR_RED = 0xcc0000;
const COLOR_YELLOW = 0xcc9900;

function truncate(value: string, max = 1024): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatHandoffEmbed(
  ctx: HandoffNotificationContext,
  opts: { includePrompt?: boolean } = {},
): DiscordEmbed {
  const color =
    ctx.status === "completed"
      ? COLOR_GREEN
      : ctx.status === "failed" || ctx.status === "rejected"
        ? COLOR_RED
        : COLOR_YELLOW;

  const fields: DiscordField[] = [
    { name: "agent", value: ctx.agent, inline: true },
    { name: "status", value: ctx.status, inline: true },
    { name: "latency", value: `${ctx.latency_seconds}s`, inline: true },
    { name: "handoff", value: ctx.handoff_id },
    { name: "conversation", value: ctx.conversation_id },
  ];

  if (ctx.error_summary) fields.push({ name: "error", value: truncate(ctx.error_summary) });
  if (ctx.pr_url) fields.push({ name: "pr", value: truncate(ctx.pr_url) });
  if (opts.includePrompt && ctx.prompt)
    fields.push({ name: "prompt", value: truncate(ctx.prompt) });

  return {
    title: `penumbra dispatch ${ctx.status}`,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function formatMergeResultEmbed(
  ctx: MergeResultNotificationContext,
  opts: { includePrompt?: boolean } = {},
): DiscordEmbed {
  const success = ctx.status === "pr_opened" || ctx.status === "verified";
  const fields: DiscordField[] = [
    { name: "agent", value: ctx.agent, inline: true },
    { name: "status", value: ctx.status, inline: true },
    { name: "handoff", value: ctx.handoff_id },
    { name: "conversation", value: ctx.conversation_id },
  ];

  if (ctx.pr_url) fields.push({ name: "pr", value: truncate(ctx.pr_url) });
  if (ctx.regression_summary)
    fields.push({ name: "error", value: truncate(ctx.regression_summary) });
  if (opts.includePrompt && ctx.prompt)
    fields.push({ name: "prompt", value: truncate(ctx.prompt) });

  return {
    title: `penumbra reconcile ${ctx.status}`,
    color: success ? COLOR_GREEN : COLOR_RED,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export async function postToDiscord(
  webhookUrl: string | undefined,
  contentOrEmbed: string | DiscordEmbedsPayload,
  fetchFn: DiscordFetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  identity?: DiscordWebhookIdentity,
): Promise<boolean> {
  if (!webhookUrl) return false;

  const payload = {
    ...(typeof contentOrEmbed === "string" ? { content: contentOrEmbed } : contentOrEmbed),
    ...(identity?.username ? { username: identity.username } : {}),
    ...(identity?.avatar_url ? { avatar_url: identity.avatar_url } : {}),
  };

  const post = async () => {
    return fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  };

  try {
    let res = await post();
    if (res.status >= 500 && res.status < 600) {
      await sleep(1000);
      res = await post();
    }
    return res.ok;
  } catch {
    // Fire-and-forget by design.
    return false;
  }
}
