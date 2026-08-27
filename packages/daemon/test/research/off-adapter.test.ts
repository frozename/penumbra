import { describe, expect, it } from "bun:test";

import { OffAdapter } from "../../src/research/off-adapter.js";

describe("OffAdapter", () => {
  it("search resolves to an empty result set", async () => {
    const adapter = new OffAdapter();
    const results = await adapter.search({ query: "anything" });
    expect(results).toEqual([]);
  });

  it("scrape resolves to an empty unbilled webfetch result for the given url", async () => {
    const adapter = new OffAdapter();
    const result = await adapter.scrape({ url: "https://example.com/page" });

    expect(result.url).toBe("https://example.com/page");
    expect(result.title).toBe("");
    expect(result.markdown).toBe("");
    expect(result.source_provider).toBe("webfetch");
    expect(result.source_billed_usd).toBe(0);
    expect(Number.isNaN(Date.parse(result.fetched_at))).toBe(false);
  });
});
