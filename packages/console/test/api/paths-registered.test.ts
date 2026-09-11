import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TOPIC_PATHS, type TopicSpec } from "@src/api/streams.js";

const serveSource = readFileSync(resolve(import.meta.dir, "../../../daemon/src/serve.ts"), "utf8");

const staticPaths = [...serveSource.matchAll(/staticRoute\(\s*"(?:GET|POST)",\s*"([^"]+)"/g)].map(
  (m) => m[1]!,
);

const regexSources = [
  ...serveSource.matchAll(
    /regexRoute\(\s*"(?:GET|POST)",\s*\/((?:\[[^\]]*\]|\\.|[^/[\n])+)\/[a-z]*\s*,/g,
  ),
].map((m) => m[1]!);

expect(regexSources).toContain("^\\/handoffs\\/([^/]+)\\/approve$");
expect(regexSources.length).toBeGreaterThan(50);

const domainsDir = resolve(import.meta.dir, "../../src/api/domains");

type PathEntry = [string, string, string | TopicSpec];

const collected: PathEntry[] = [];

for (const file of readdirSync(domainsDir)) {
  if (!file.endsWith(".ts")) continue;
  const mod = (await import(pathToFileURL(resolve(domainsDir, file)).href)) as {
    PATHS: Record<string, string>;
  };
  expect(typeof mod.PATHS).toBe("object");
  const basename = file.replace(/\.ts$/, "");
  for (const [key, value] of Object.entries(mod.PATHS)) {
    collected.push([basename, key, value]);
  }
}

for (const [key, value] of Object.entries(TOPIC_PATHS)) {
  collected.push(["streams", key, value]);
}

function isPathRegistered(
  spec: string | TopicSpec,
  staticPaths: Set<string>,
  regexSourceSet: Set<string>,
  compiledRegexes: RegExp[],
): boolean {
  if (typeof spec === "string") {
    if (spec === "/health") return true;
    if (staticPaths.has(spec)) return true;
    const regexStr = "^" + spec.replaceAll("/", "\\/").replaceAll(/:[A-Za-z_]+/g, "([^/]+)") + "$";
    return regexSourceSet.has(regexStr);
  }
  const samplePath = spec.path(spec.sample);
  if (staticPaths.has(samplePath)) return true;
  return compiledRegexes.some((re) => re.test(samplePath));
}

export function findUnregistered(
  entries: [string, string, string | TopicSpec][],
  serveSource: string,
): string[] {
  const staticPaths = new Set(
    [...serveSource.matchAll(/staticRoute\(\s*"(?:GET|POST)",\s*"([^"]+)"/g)].map((m) => m[1]!),
  );
  const regexSources = [
    ...serveSource.matchAll(
      /regexRoute\(\s*"(?:GET|POST)",\s*\/((?:\[[^\]]*\]|\\.|[^/[\n])+)\/[a-z]*\s*,/g,
    ),
  ].map((m) => m[1]!);
  const regexSourceSet = new Set(regexSources);
  const compiledRegexes = regexSources.map((rs) => new RegExp(rs));

  const unregistered: string[] = [];
  for (const [slice, key, spec] of entries) {
    if (isPathRegistered(spec, staticPaths, regexSourceSet, compiledRegexes)) continue;
    const displayPath = typeof spec === "string" ? spec : spec.path(spec.sample);
    unregistered.push(`${slice}.${key} -> ${displayPath}`);
  }
  return unregistered;
}

describe("paths-registered", () => {
  test("every PATHS entry of every src/api/domains/*.ts and every TOPIC_PATHS value (string or function-valued sample) is matched by a staticRoute literal or a regexRoute source in packages/daemon/src/serve.ts, or is /health", () => {
    expect(findUnregistered(collected, serveSource)).toEqual([]);
  });

  test("a PATHS entry '/handoffs/:id/defer' fails naming the slice and key", () => {
    expect(findUnregistered([["handoffs", "defer", "/handoffs/:id/defer"]], serveSource)).toEqual([
      "handoffs.defer -> /handoffs/:id/defer",
    ]);
  });
});
