import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type AgentConfig } from "@penumbra/config";

import { DaemonClient } from "../src/daemon-client.js";
import { buildServer } from "../src/server.js";

export type LongLivedAgentFixture = AgentConfig & { display_name?: string };

export interface LongLivedAgentFixtureInput {
  name: string;
  display_name?: string;
  standing_brief?: string;
  schedule_cron?: string;
  subscriptions?: { server: string; event: string }[];
  mcp_allowlist?: string[];
}

export function buildLongLivedAgentFixture(
  input: LongLivedAgentFixtureInput,
): LongLivedAgentFixture {
  // Test boundary: the reconciler reads display_name via a side-channel
  // (`(a as any).display_name`) that the AgentConfig schema does not expose, so
  // we widen the fixture type with the optional field rather than smuggling it
  // through `as any`.
  return {
    name: input.name,
    adapter: "test",
    options: {},
    roles: [],
    auto_approve_to: [],
    pricing_mode: "api",
    display_name: input.display_name,
    long_lived: true,
    long_lived_config: {
      schedule_cron: input.schedule_cron ?? "*/1 * * * *",
      subscriptions: input.subscriptions ?? [],
      hosted_mcp_servers: [],
      mcp_allowlist: input.mcp_allowlist ?? [],
      require_snapshot: false,
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: input.standing_brief ?? "x",
    },
  };
}

export async function connectInMemory(daemon: DaemonClient): Promise<Client> {
  const server = await buildServer({ daemon });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

export function fakeDaemon(partial: Partial<DaemonClient> = {}): DaemonClient {
  // Test-only boundary: synthesize a structurally minimal DaemonClient. Tests
  // override only the methods they touch; the cast across the test boundary is
  // safe because no test reaches into the private fields of DaemonClient.
  return partial as unknown as DaemonClient;
}

export type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

export function firstText(result: CallToolResult): string {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("expected tool result content[0]");
  }
  const block = content[0] as { type: string; text?: unknown };
  if (typeof block.text !== "string") {
    throw new Error("expected tool result content[0].text");
  }
  return block.text;
}

export function firstJson<T = unknown>(result: CallToolResult): T {
  return JSON.parse(firstText(result)) as T;
}

export type FetchImpl = typeof fetch;

export interface FetchHarness {
  daemon: DaemonClient;
  restore: () => void;
}

// Installs a fetch mock for tools that talk to the daemon via the real fetch
// path. Returned `restore` is an arrow (not a method shorthand) so callers can
// destructure it without losing `this` and tripping `@typescript-eslint/unbound-method`.
export function installFetchMock(fetchImpl: FetchImpl): FetchHarness {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const daemon = new DaemonClient({ baseUrl: "http://daemon", token: "t" });
  return {
    daemon,
    restore: (): void => {
      globalThis.fetch = original;
    },
  };
}

// `typeof fetch` accepts `Request | URL | string` as the first arg, but
// `Request` lacks a meaningful `toString()` for our test asserts. Resolve to a
// concrete URL string without relying on default Object stringification, which
// keeps `@typescript-eslint/no-base-to-string` quiet.
export function requestUrl(input: Request | URL | string): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// Same shape concern as `requestUrl`, but for the request body. The mock-only
// JSON paths in these tests always send a JSON string body; assert it instead
// of coercing arbitrary BodyInit shapes through `String(...)`. The input type
// matches `RequestInit["body"]` without naming `BodyInit`, which Node's typings
// expose as an error-fallback type the strict eslint config refuses to union.
export function bodyAsString(body: RequestInit["body"]): string {
  if (typeof body !== "string") {
    const tag = body === null || body === undefined ? String(body) : typeof body;
    throw new TypeError(`expected request body to be a string, got ${tag}`);
  }
  return body;
}
