import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { DaemonClient } from "../src/daemon-client.js";

import { buildServer } from "../src/server.js";

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
