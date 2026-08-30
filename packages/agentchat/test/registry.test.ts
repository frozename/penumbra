import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentChatConfig } from "../src/config/types.js";

import { buildAdapter } from "../src/adapters/registry.js";
import { getAgentDescriptor } from "../src/registry.js";

type FetchFn = typeof fetch;
const asFetchFn = (m: ReturnType<typeof mock>): FetchFn => m as unknown as FetchFn;

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

type MockFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

function neverResolvingFetchUntilAbort(): ReturnType<typeof mock<MockFetch>> {
  const implementation: MockFetch = (_url, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return;
      const rejectAbort = (): void => {
        const reason = signal.reason as unknown;
        reject(reason instanceof Error ? reason : new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
  };
  return mock<MockFetch>(implementation);
}

async function expectRejectsBeforeWatchdog(
  promise: Promise<unknown>,
  watchdogMs: number,
): Promise<Error> {
  const result = await Promise.race<unknown>([
    promise.catch((err: unknown) => err),
    new Promise((resolve) =>
      setTimeout(() => {
        resolve("watchdog");
      }, watchdogMs),
    ),
  ]);
  if (result === "watchdog") {
    throw new Error("request did not reject before watchdog");
  }
  if (!(result instanceof Error)) {
    throw new Error("expected promise to reject with an Error");
  }
  return result;
}

const cfg: AgentChatConfig = {
  agents: [
    {
      name: "codex",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
      tags: ["core", "ts"],
      tier: "oc",
      cost_cents_per_run: 12,
    },
  ],
  default_roles: {},
  providers: [],
  notifications: undefined,
  thoughts: undefined,
  shell: undefined,
};

const maestroCapableCfg: AgentChatConfig = {
  ...cfg,
  agents: [
    ...cfg.agents,
    {
      name: "maestro-true",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
      maestro_capable: true,
    },
    {
      name: "maestro-false",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
      maestro_capable: false,
    },
    {
      name: "maestro-default",
      adapter: "codex-cli",
      options: {},
      roles: [],
      auto_approve_to: [],
    },
  ],
};

describe("getAgentDescriptor", () => {
  test("returns descriptor for known agent", () => {
    expect(getAgentDescriptor("codex", cfg)).toEqual({
      name: "codex",
      tags: ["core", "ts"],
      tier: "oc",
      cost_cents_per_run: 12,
      maestro_capable: false,
    });
  });

  test("returns maestro_capable true when configured", () => {
    expect(getAgentDescriptor("maestro-true", maestroCapableCfg)).toMatchObject({
      name: "maestro-true",
      maestro_capable: true,
    });
  });

  test("returns maestro_capable false when configured false", () => {
    expect(getAgentDescriptor("maestro-false", maestroCapableCfg)).toMatchObject({
      name: "maestro-false",
      maestro_capable: false,
    });
  });

  test("defaults maestro_capable to false when omitted", () => {
    expect(getAgentDescriptor("maestro-default", maestroCapableCfg)).toMatchObject({
      name: "maestro-default",
      maestro_capable: false,
    });
  });

  test("returns undefined for unknown agent", () => {
    expect(getAgentDescriptor("unknown", cfg)).toBeUndefined();
  });
});

describe("buildAdapter", () => {
  test("forwards requestTimeoutMs to openai-compat-http adapter construction", async () => {
    global.fetch = asFetchFn(neverResolvingFetchUntilAbort());
    const cleanup = new AbortController();
    const adapter = buildAdapter("openai-compat-http", {
      baseUrl: "http://example/v1",
      apiKey: "tk",
      model: "m",
      requestTimeoutMs: 20,
    });

    try {
      const err = await expectRejectsBeforeWatchdog(
        adapter.dispatch({
          prompt: "p",
          conversation: { id: "c", project_id: null },
          config: {},
          signal: cleanup.signal,
        }),
        200,
      );
      expect(err.message).toMatch(/openai-compat-http request timed out after 20ms/);
    } finally {
      cleanup.abort(new Error("test cleanup"));
    }
  });
});
