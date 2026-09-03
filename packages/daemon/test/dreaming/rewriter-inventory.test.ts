import type { LlamactlInventory, LlmCandidate } from "@penumbra/core";

import { expect, it } from "bun:test";

import type { DreamingRewriterInventory } from "@src/dreaming/rewriter-inventory.js";
import { resolveRewriterCandidatesAgainstInventory } from "@src/dreaming/rewriter-inventory.js";

function inventoryWithModels(models: LlamactlInventory["models"]): DreamingRewriterInventory {
  const inventory: LlamactlInventory = { status: "ok", messages: [], nodes: [], models };
  return { collect: () => Promise.resolve(inventory) };
}

function candidate(
  overrides: Partial<LlmCandidate> & { name: string; baseUrl: string; model: string },
): LlmCandidate {
  return { provider: "local", auth: { source: "none" }, ...overrides };
}

async function resolveAgainstInventory(
  candidates: LlmCandidate[],
  models: LlamactlInventory["models"],
): Promise<LlmCandidate[]> {
  return await resolveRewriterCandidatesAgainstInventory({
    candidates,
    inventory: inventoryWithModels(models),
  });
}

it("keeps an IP-addressed LAN candidate whose model is advertised in inventory", async () => {
  const macmini = candidate({
    name: "macmini-raw-ip",
    baseUrl: "https://192.168.68.76:7843",
    model: "granite-mini-3b",
    provider: "unknown",
  });
  const survivors = await resolveAgainstInventory(
    [macmini],
    [
      {
        id: "granite-mini-3b",
        owned_by: "mac-mini.local",
        node: { name: "mac-mini.local", endpoint: "http://192.168.68.76:7843" },
      },
    ],
  );
  expect(survivors).toEqual([macmini]);
});

it("drops an IP-addressed LAN candidate whose model is not advertised", async () => {
  const macmini = candidate({
    name: "macmini-raw-ip",
    baseUrl: "https://192.168.68.76:7843",
    model: "granite-mini-3b",
    provider: "unknown",
  });
  const survivors = await resolveAgainstInventory(
    [macmini],
    [
      {
        id: "lfm2-generator",
        owned_by: "local-host",
        node: { name: "local-host", endpoint: "http://127.0.0.1:7945" },
      },
    ],
  );
  expect(survivors).toEqual([]);
});

it("treats 10.x and 172.16-31.x candidates as LAN", async () => {
  const lanTen = candidate({
    name: "lan-10",
    baseUrl: "http://10.0.0.5:7843",
    model: "model-a",
    provider: "unknown",
  });
  const lanSeventeenLow = candidate({
    name: "lan-172-16",
    baseUrl: "http://172.16.9.2:7843",
    model: "model-b",
    provider: "unknown",
  });
  const lanSeventeenHigh = candidate({
    name: "lan-172-31",
    baseUrl: "http://172.31.0.7:7843",
    model: "model-c",
    provider: "unknown",
  });
  const survivors = await resolveAgainstInventory(
    [lanTen, lanSeventeenLow, lanSeventeenHigh],
    [
      { id: "model-a", node: { name: "node-a", endpoint: "http://10.0.0.5:7843" } },
      { id: "model-b", node: { name: "node-b", endpoint: "http://172.16.9.2:7843" } },
      { id: "model-c", node: { name: "node-c", endpoint: "http://172.31.0.7:7843" } },
    ],
  );
  expect(survivors).toEqual([lanTen, lanSeventeenLow, lanSeventeenHigh]);
});

it("rejects a public routable candidate even when its model is advertised locally", async () => {
  const publicCandidate = candidate({
    name: "public-host",
    baseUrl: "https://api.example.com",
    model: "shared-model",
    provider: "unknown",
  });
  const survivors = await resolveAgainstInventory(
    [publicCandidate],
    [{ id: "shared-model", node: { name: "local-host", endpoint: "http://127.0.0.1:7945" } }],
  );
  expect(survivors).toEqual([]);
});

it("never selects models served by cloud gateway nodes", async () => {
  const localSeatForGatewayNode = candidate({
    name: "local-seat",
    baseUrl: "http://127.0.0.1:7944",
    model: "groq-model",
  });
  const localSeatForGatewayOwner = candidate({
    name: "local-seat-owned",
    baseUrl: "http://127.0.0.1:7944",
    model: "anthropic-model",
  });
  const survivors = await resolveAgainstInventory(
    [localSeatForGatewayNode, localSeatForGatewayOwner],
    [
      { id: "groq-model", node: { name: "groq", endpoint: "http://10.0.0.5:8080" } },
      { id: "anthropic-model", owned_by: "anthropic-direct" },
    ],
  );
  expect(survivors).toEqual([]);
});
