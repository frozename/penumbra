import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../plugin/agents/penumbra-dispatcher.md", import.meta.url),
  "utf8",
);

const flat = (s: string): string => s.replaceAll(/\s+/g, " ");

describe("penumbra-dispatcher brief authority", () => {
  const section = source.split("## Brief authority")[1]?.split("## Protocol")[0];

  test("a Brief authority section precedes the Protocol", () => {
    expect(section).toBeDefined();
    expect(source.indexOf("## Brief authority")).toBeLessThan(source.indexOf("## Protocol"));
    expect(source.indexOf("## Brief authority")).toBeGreaterThan(-1);
  });

  test("the brief fields are authoritative and may not be substituted", () => {
    const text = flat(section ?? "");
    expect(text).toContain("`initial_agent`");
    expect(text).toContain("are authoritative");
    expect(text).toContain(
      "Never substitute, withhold or re-route a dispatch because of other context you can see",
    );
  });

  test("a concern is reported while still dispatching", () => {
    const text = flat(section ?? "");
    expect(text).toContain("dispatch it anyway");
    expect(text).toContain("`proxy_concern:`");
  });

  test("a refusal has its own status distinct from start_error", () => {
    const text = flat(section ?? "");
    expect(text).toContain('status="refused_by_proxy"');
    expect(text).toContain("`refused_by_proxy:`");
    expect(text).toContain("Never report a refusal as `start_error`");
  });

  test("protocol step 6 routes refusals to refused_by_proxy", () => {
    const step6 = source.split("6. Return StructuredOutput")[1]?.split("## Hard rules")[0];
    expect(step6).toBeDefined();
    expect(flat(step6 ?? "")).toContain('status="refused_by_proxy"');
  });
});
