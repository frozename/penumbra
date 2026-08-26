import { describe, expect, test } from "bun:test";

import { assertDiscoveryNotSuspiciouslyEmpty } from "../../src/generator/empty-discovery.js";

describe("assertDiscoveryNotSuspiciouslyEmpty", () => {
  test("an empty discovery result with no paired control confirmation produces a no-change result, never a prune-everything result", () => {
    expect(() => {
      assertDiscoveryNotSuspiciouslyEmpty([]);
    }).toThrow(/suspiciously empty|zero results|control confirmation/i);
  });

  test("does not throw when the discovery result is non-empty", () => {
    expect(() => {
      assertDiscoveryNotSuspiciouslyEmpty(["model-a"]);
    }).not.toThrow();
  });

  test("does not throw when an empty result is confirmed by a passing control check", () => {
    expect(() => {
      assertDiscoveryNotSuspiciouslyEmpty([], { controlCheck: () => true });
    }).not.toThrow();
  });

  test("still throws when an empty result's control check itself fails", () => {
    expect(() => {
      assertDiscoveryNotSuspiciouslyEmpty([], { controlCheck: () => false });
    }).toThrow();
  });
});
