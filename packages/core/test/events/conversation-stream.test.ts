import { describe, expect, test } from "bun:test";
import { ConversationStreamBus } from "@penumbra/core";
import type {
  ConversationChainEndEvent,
  ConversationHopEndEvent,
  ConversationHopStartEvent,
  ConversationTokenEvent,
} from "@penumbra/core";

function hopStart(conv: string, handoff = `${conv}-h`): ConversationHopStartEvent {
  return {
    type: "hop-start",
    handoff_id: handoff,
    chain_id: conv,
    idx: 0,
    agent_name: "test-agent",
    status: "in_progress",
  };
}

function token(handoff: string, seq: number, delta = "x"): ConversationTokenEvent {
  return { type: "token", handoff_id: handoff, seq, delta };
}

function hopEnd(handoff: string, chain: string): ConversationHopEndEvent {
  return {
    type: "hop-end",
    handoff_id: handoff,
    chain_id: chain,
    next_handoff_id: null,
    error: null,
  };
}

function chainEnd(chain: string): ConversationChainEndEvent {
  return { type: "chain-end", chain_id: chain, reason: "completed" };
}

describe("ConversationStreamBus", () => {
  test("subscribers receive emitted events in order and survive bad subscribers", () => {
    const bus = new ConversationStreamBus({ now: () => 0 });
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((_id, evt) => seen.push(evt.type));
    bus.emit("c1", hopStart("c1", "h1"));
    bus.emit("c1", token("h1", 0));
    bus.emit("c1", hopEnd("h1", "c1"));
    expect(seen).toEqual(["hop-start", "token", "hop-end"]);
  });

  test("getHistory returns cached hop-start plus tokens for the active hop", () => {
    const bus = new ConversationStreamBus({ now: () => 0 });
    bus.emit("c1", hopStart("c1", "h1"));
    bus.emit("c1", token("h1", 0, "a"));
    bus.emit("c1", token("h1", 1, "b"));
    const history = bus.getHistory("c1");
    expect(history.map((e) => e.type)).toEqual(["hop-start", "token", "token"]);
  });

  test("hop-end and chain-end clear the cached entry", () => {
    const bus = new ConversationStreamBus({ now: () => 0 });
    bus.emit("c1", hopStart("c1", "h1"));
    bus.emit("c2", hopStart("c2", "h2"));
    bus.emit("c1", hopEnd("h1", "c1"));
    bus.emit("c2", chainEnd("c2"));
    expect(bus.getHistory("c1")).toEqual([]);
    expect(bus.getHistory("c2")).toEqual([]);
  });

  test("cache evicts oldest entries past maxEntries (LRU)", () => {
    const bus = new ConversationStreamBus({ maxEntries: 3, now: () => 0 });
    bus.emit("c1", hopStart("c1"));
    bus.emit("c2", hopStart("c2"));
    bus.emit("c3", hopStart("c3"));
    expect(bus.getHistory("c1").length).toBe(1);

    bus.emit("c4", hopStart("c4"));
    expect(bus.getHistory("c1")).toEqual([]);
    expect(bus.getHistory("c2").length).toBe(1);
    expect(bus.getHistory("c3").length).toBe(1);
    expect(bus.getHistory("c4").length).toBe(1);
  });

  test("active conversations refresh LRU position via token emits and survive overflow", () => {
    const bus = new ConversationStreamBus({ maxEntries: 2, now: () => 0 });
    bus.emit("active", hopStart("active", "ha"));
    bus.emit("filler", hopStart("filler", "hf"));
    // Touch 'active' so 'filler' is now LRU.
    bus.emit("active", token("ha", 0));
    bus.emit("new", hopStart("new", "hn"));
    expect(bus.getHistory("active").length).toBeGreaterThan(0);
    expect(bus.getHistory("filler")).toEqual([]);
    expect(bus.getHistory("new").length).toBe(1);
  });

  test("active conversations survive TTL eviction while stale ones are reclaimed", () => {
    let now = 0;
    const bus = new ConversationStreamBus({ ttlMs: 1000, now: () => now });

    bus.emit("active", hopStart("active", "ha"));
    bus.emit("stale", hopStart("stale", "hs"));

    // Refresh 'active' so its last_ts is 500.
    now = 500;
    bus.emit("active", token("ha", 0));

    // Advance past TTL relative to 'stale' (0) but not 'active' (500).
    now = 1200;
    bus.emit("trigger", hopStart("trigger", "ht"));

    expect(bus.getHistory("active").length).toBeGreaterThan(0);
    expect(bus.getHistory("stale")).toEqual([]);
    expect(bus.getHistory("trigger").length).toBe(1);
  });

  test("tokens are capped per entry so a runaway hop cannot grow unbounded", () => {
    const bus = new ConversationStreamBus({ maxTokensPerEntry: 4, now: () => 0 });
    bus.emit("c1", hopStart("c1", "h1"));
    for (let i = 0; i < 100; i++) bus.emit("c1", token("h1", i));

    const history = bus.getHistory("c1");
    expect(history.length).toBe(1 + 4);
    const seqs = history.slice(1).map((e) => (e as ConversationTokenEvent).seq);
    expect(seqs).toEqual([96, 97, 98, 99]);
  });

  test("token with mismatched handoff_id is not cached but still broadcast", () => {
    const bus = new ConversationStreamBus({ now: () => 0 });
    const seen: string[] = [];
    bus.subscribe((_id, evt) => seen.push(evt.type));
    bus.emit("c1", hopStart("c1", "h1"));
    bus.emit("c1", token("other-handoff", 0));
    expect(bus.getHistory("c1").map((e) => e.type)).toEqual(["hop-start"]);
    expect(seen).toEqual(["hop-start", "token"]);
  });
});
