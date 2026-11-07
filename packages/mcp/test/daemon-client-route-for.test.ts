import { afterEach, expect, mock, test } from "bun:test";

import { DaemonClient } from "@src/daemon-client.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchHandler = (input: FetchInput, init?: FetchInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

function readUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function newClient(): DaemonClient {
  return new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
}

function recordUrls(seen: string[]): FetchHandler {
  return mock((input: FetchInput) => {
    seen.push(readUrl(input));
    return Promise.resolve(Response.json({}));
  });
}

test("agentRouteFor sends role as the only query param", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().agentRouteFor({ role: "planner" });
  expect(seen[0]).toBe("http://localhost:1234/agents/route_for?role=planner");
});

test("agentRouteFor form-encodes the role", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().agentRouteFor({ role: "a b&c" });
  expect(seen[0]).toBe("http://localhost:1234/agents/route_for?role=a+b%26c");
});

test("agentRouteFor sends window_days=0 (undefined check, not truthiness)", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().agentRouteFor({ role: "r", window_days: 0 });
  expect(seen[0]).toBe("http://localhost:1234/agents/route_for?role=r&window_days=0");
});

test("agentRouteFor sends min_samples", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().agentRouteFor({ role: "r", min_samples: 3 });
  expect(seen[0]).toBe("http://localhost:1234/agents/route_for?role=r&min_samples=3");
});

test("agentRouteFor sends agent_kind", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().agentRouteFor({ role: "r", agent_kind: "coding" });
  expect(seen[0]).toBe("http://localhost:1234/agents/route_for?role=r&agent_kind=coding");
});

test("agentRouteFor orders query params role, window_days, min_samples, agent_kind", async () => {
  const seen: string[] = [];
  mockFetch(recordUrls(seen));
  await newClient().agentRouteFor({
    role: "r",
    window_days: 7,
    min_samples: 3,
    agent_kind: "long_lived",
  });
  expect(seen[0]).toBe(
    "http://localhost:1234/agents/route_for?role=r&window_days=7&min_samples=3&agent_kind=long_lived",
  );
});
