import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiscoveredModel } from "./discovery-types.js";

const execFileAsync = promisify(execFile);
const OPENCODE_SOURCE_PROVIDER_ID = "opencode";
const DISCOVERY_CLI_TIMEOUT_MS = 30_000;

export interface DiscoverOpencodeModelsOpts {
  runOpencodeModels?: () => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isModelSlug(line: string): boolean {
  return line === line.trim() && /^[^\s/]+\/[^\s/]+$/.test(line);
}

function findJsonObjectEnd(lines: string[], startIndex: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    for (const character of lines[lineIndex] ?? "") {
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
        started = true;
      } else if (character === "}") {
        depth -= 1;
        if (started && depth === 0) return lineIndex;
      }
    }
  }

  return undefined;
}

export function parseOpencodeModelsOutput(output: string): DiscoveredModel[] {
  const lines = output.split(/\r?\n/);
  const models: DiscoveredModel[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const slug = lines[lineIndex] ?? "";
    if (!isModelSlug(slug)) continue;

    let objectStart = lineIndex + 1;
    while (objectStart < lines.length && lines[objectStart]?.trim() === "") objectStart += 1;
    if (lines[objectStart]?.trim() !== "{") continue;

    const objectEnd = findJsonObjectEnd(lines, objectStart);
    if (objectEnd === undefined) continue;

    try {
      const parsed = JSON.parse(lines.slice(objectStart, objectEnd + 1).join("\n")) as unknown;
      if (isRecord(parsed) && typeof parsed.name === "string") {
        models.push({
          sourceProviderId: OPENCODE_SOURCE_PROVIDER_ID,
          modelId: slug,
          displayName: parsed.name,
        });
      }
    } catch {
      // A malformed model block must not prevent discovery of subsequent blocks.
    }

    lineIndex = objectEnd;
  }

  return models;
}

async function defaultRunOpencodeModels(): Promise<string> {
  const promise = execFileAsync("opencode", ["models", "--verbose"], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: DISCOVERY_CLI_TIMEOUT_MS,
  });
  promise.child.stdin?.end();
  const { stdout } = await promise;
  return stdout;
}

export async function discoverOpencodeModels(
  opts: DiscoverOpencodeModelsOpts = {},
): Promise<DiscoveredModel[]> {
  const output = await (opts.runOpencodeModels ?? defaultRunOpencodeModels)();
  return parseOpencodeModelsOutput(output);
}
