import { expect, test } from "bun:test";

import { buildSummaryLine, parseCliArgs } from "./t2-crash-repro.ts";

test("parseCliArgs accepts parent runtimes and stub flag", () => {
  const parsed = parseCliArgs([
    "--runtimes",
    "/tmp/bun-a,/tmp/bun-b",
    "--runs",
    "2",
    "--stub-embed",
  ]);

  expect(parsed.mode).toBe("parent");
  expect(parsed.runtimes).toEqual(["/tmp/bun-a", "/tmp/bun-b"]);
  expect(parsed.runsPerRuntime).toBe(2);
  expect(parsed.stubEmbed).toBe(true);
});

test("buildSummaryLine emits one JSON object with run rows", () => {
  const line = buildSummaryLine([
    {
      runtime_binary: "/tmp/bun",
      bun_version: "1.4.0",
      exit_code: 0,
      signal: null,
      outcome: "completed",
      duration_ms: 123,
    },
  ]);

  expect(JSON.parse(line)).toEqual({
    runs: [
      {
        runtime_binary: "/tmp/bun",
        bun_version: "1.4.0",
        exit_code: 0,
        signal: null,
        outcome: "completed",
        duration_ms: 123,
      },
    ],
  });
});
