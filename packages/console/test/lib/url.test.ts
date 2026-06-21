import { describe, expect, test } from "bun:test";

import { buildRequestUrl } from "../../src/lib/url.js";

describe("buildRequestUrl", () => {
  test("builds relative baseUrl + simple path", () => {
    expect(buildRequestUrl("/api", "/handoffs")).toBe("/api/handoffs");
  });

  test("normalizes relative baseUrl trailing slash", () => {
    expect(buildRequestUrl("/api/", "/handoffs")).toBe("/api/handoffs");
  });

  test("builds absolute baseUrl", () => {
    expect(buildRequestUrl("http://127.0.0.1:51257", "/handoffs")).toBe(
      "http://127.0.0.1:51257/handoffs",
    );
  });

  test("avoids double slash for leading path + trailing base slash", () => {
    expect(buildRequestUrl("http://127.0.0.1:51257/", "/handoffs")).toBe(
      "http://127.0.0.1:51257/handoffs",
    );
  });

  test("appends params and skips undefined/null values", () => {
    expect(
      buildRequestUrl("http://127.0.0.1:51257", "/chains", {
        status: "pending",
        limit: 10,
        skip: undefined,
        project_id: null,
      }),
    ).toBe("http://127.0.0.1:51257/chains?status=pending&limit=10");
  });

  test("handles mixed undefined/string params", () => {
    expect(
      buildRequestUrl("/api", "/dispatch-events/stream", {
        kind: "a",
        scope: undefined,
        since: "2026-05-09T00:00:00Z",
      }),
    ).toBe("/api/dispatch-events/stream?kind=a&since=2026-05-09T00%3A00%3A00Z");
  });
});
