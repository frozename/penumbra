import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOtlpLogs } from "../../src/otlp/parse.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

describe("parseOtlpLogs", () => {
  it("extracts log records from a gemini-cli OTLP/JSON logs envelope", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "gemini-logs.json"), "utf8");
    const records = parseOtlpLogs(JSON.parse(raw));
    expect(records.length).toBeGreaterThan(0);
    const inference = records.find(
      (r) =>
        r.attrs["event.name"] === "gen_ai.client.inference.operation.details" &&
        typeof r.attrs["gen_ai.usage.input_tokens"] === "number",
    );
    expect(inference).toBeDefined();
    expect(inference!.attrs["gen_ai.request.model"]).toBe("gemini-3-flash-preview");
    expect(inference!.attrs["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(inference!.attrs["gen_ai.usage.output_tokens"]).toBeGreaterThanOrEqual(0);
    expect(inference!.resourceAttrs["service.name"]).toBe("gemini-cli");
  });

  it("returns [] for an envelope with no resourceLogs", () => {
    expect(parseOtlpLogs({})).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: [] })).toEqual([]);
  });

  it("handles empty value objects (e.g. unset gen_ai.request.seed)", () => {
    const env = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "x" } }] },
          scopeLogs: [
            {
              scope: { name: "x" },
              logRecords: [{ attributes: [{ key: "k", value: {} }] }],
            },
          ],
        },
      ],
    };
    const records = parseOtlpLogs(env);
    expect(records[0]!.attrs["k"]).toBeNull();
  });
});
