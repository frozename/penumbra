import { describe, expect, it, mock } from "bun:test";

import {
  type DiscordEmbed,
  type DiscordField,
  formatHandoffEmbed,
  formatMergeResultEmbed,
  postToDiscord,
} from "../../src/worker/discord-notifier.js";

interface FetchCallArgs {
  input: string | URL | Request;
  init?: RequestInit;
}

function firstFetchCall(fetchMock: ReturnType<typeof mock>): FetchCallArgs {
  const calls = fetchMock.mock.calls as unknown as [string | URL | Request, RequestInit?][];
  const call = calls[0];
  if (!call) throw new Error("expected mock to be called");
  return { input: call[0], init: call[1] };
}

interface DiscordRequestBody {
  content?: string;
  username?: string;
  avatar_url?: string;
}

function parseRequestBody(init: RequestInit | undefined): DiscordRequestBody {
  if (init?.body === undefined || init.body === null) {
    throw new Error("expected request body to be present");
  }
  return JSON.parse(init.body as string) as DiscordRequestBody;
}

function findField(embed: DiscordEmbed, name: string): DiscordField | undefined {
  return embed.fields.find((f) => f.name === name);
}

describe("postToDiscord", () => {
  it("no-ops when webhookUrl is undefined", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("", { status: 200 })));

    const ok = await postToDiscord(undefined, "msg", fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ok).toBe(false);
  });

  it("posts a content payload to the webhook URL", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("", { status: 204 })));

    const ok = await postToDiscord("https://discord.com/api/webhooks/abc", "hello", fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
    const { input, init } = firstFetchCall(fetchMock);
    expect(input).toBe("https://discord.com/api/webhooks/abc");
    expect(init?.method).toBe("POST");
    const body = parseRequestBody(init);
    expect(body.content).toBe("hello");
  });

  it("retries once on 5xx", async () => {
    let calls = 0;
    const sleepMock = mock((_ms: number) => Promise.resolve());
    const fetchMock = mock(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(new Response("", { status: 204 }));
    });

    const ok = await postToDiscord(
      "https://discord.com/api/webhooks/abc",
      "hello",
      fetchMock,
      sleepMock,
    );

    expect(calls).toBe(2);
    expect(ok).toBe(true);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });

  it("does not throw on permanent failure", async () => {
    const sleepMock = mock((_ms: number) => Promise.resolve());
    const fetchMock = mock(() => Promise.resolve(new Response("", { status: 500 })));

    const result = await postToDiscord(
      "https://discord.com/api/webhooks/abc",
      "hello",
      fetchMock,
      sleepMock,
    );
    expect(result).toBe(false);
  });

  it("includes webhook identity overrides in the payload", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("", { status: 204 })));

    await postToDiscord(
      "https://discord.test/api/webhooks/abc",
      { embeds: [{ title: "x", color: 0, fields: [] }] },
      fetchMock,
      undefined,
      { username: "Penumbra / Codex", avatar_url: "https://example.com/codex.png" },
    );

    const { init } = firstFetchCall(fetchMock);
    const body = parseRequestBody(init);
    expect(body.username).toBe("Penumbra / Codex");
    expect(body.avatar_url).toBe("https://example.com/codex.png");
  });
});

describe("formatHandoffEmbed", () => {
  it("produces a green-color embed for completed handoffs", () => {
    const embed = formatHandoffEmbed({
      handoff_id: "h-1",
      agent: "codex-mini",
      status: "completed",
      latency_seconds: 8,
      conversation_id: "c-1",
    });

    expect(embed.color).toBe(0x00cc66);
    expect(findField(embed, "agent")).toMatchObject({ name: "agent", value: "codex-mini" });
    expect(findField(embed, "latency")).toMatchObject({ name: "latency", value: "8s" });
  });

  it("produces a red-color embed for failed handoffs", () => {
    const embed = formatHandoffEmbed({
      handoff_id: "h-2",
      agent: "gemini-flash",
      status: "failed",
      latency_seconds: 540,
      conversation_id: "c-2",
      error_summary: "gemini quota exhausted",
    });

    expect(embed.color).toBe(0xcc0000);
    expect(findField(embed, "error")).toMatchObject({
      name: "error",
      value: "gemini quota exhausted",
    });
  });

  it("omits prompt by default for privacy", () => {
    const embed = formatHandoffEmbed({
      handoff_id: "h-3",
      agent: "a",
      status: "completed",
      latency_seconds: 1,
      conversation_id: "c-3",
      prompt: "sensitive content",
    });

    expect(JSON.stringify(embed)).not.toContain("sensitive content");
  });
});

describe("formatMergeResultEmbed", () => {
  it("includes the PR link on pr_opened results", () => {
    const embed = formatMergeResultEmbed({
      handoff_id: "h-pr",
      conversation_id: "c-pr",
      agent: "gemini",
      status: "pr_opened",
      pr_url: "https://github.com/acordeiro/penumbra/pull/321",
    });

    expect(embed.color).toBe(0x00cc66);
    expect(findField(embed, "pr")).toMatchObject({
      name: "pr",
      value: "https://github.com/acordeiro/penumbra/pull/321",
    });
  });

  it("includes regression details for failed reconciler outcomes", () => {
    const embed = formatMergeResultEmbed({
      handoff_id: "h-fail",
      conversation_id: "c-fail",
      agent: "gemini",
      status: "typecheck_failed",
      regression_summary: "Cannot find name DiscordWebhookUrl",
    });

    expect(embed.color).toBe(0xcc0000);
    expect(findField(embed, "error")).toMatchObject({
      name: "error",
      value: "Cannot find name DiscordWebhookUrl",
    });
  });
});
