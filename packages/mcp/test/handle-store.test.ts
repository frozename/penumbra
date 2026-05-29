import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HandleStore } from "../src/handle-store.js";

describe("HandleStore", () => {
  let store: HandleStore;
  beforeEach(() => {
    store = new HandleStore({ ttlMs: 80 });
  });
  afterEach(() => store.close());

  it("stores and retrieves content by returned id", () => {
    const id = store.put("large content blob");
    expect(store.get(id)).toBe("large content blob");
  });

  it("returns undefined for unknown id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("evicts entries after TTL expires", async () => {
    const id = store.put("evictable");
    await new Promise((r) => setTimeout(r, 120));
    expect(store.get(id)).toBeUndefined();
  });

  it("generates unique ids", () => {
    const ids = Array.from({ length: 20 }, () => store.put("x"));
    expect(new Set(ids).size).toBe(20);
  });

  it("keys() returns all live entry ids", () => {
    const id1 = store.put("a");
    const id2 = store.put("b");
    expect(store.keys()).toContain(id1);
    expect(store.keys()).toContain(id2);
  });
});
