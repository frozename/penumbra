import { readFile } from "node:fs/promises";

import { parsePendingHandoffSections, pendingHandoffPath } from "../pending-handoff-file.js";

const DEFAULT_MAX_BYTES = 8192;
const DEFAULT_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PendingHandoffInput = {
  storageRoot?: string;
  project: string;
  now: () => Date;
  args: Record<string, unknown>;
};

export type PendingHandoffResult = { path: string | null; body: string; truncated: boolean };

export type PendingHandoffOutput = { result: PendingHandoffResult; warnings: string[] };

function positiveNumberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw err;
  }
}

// Only this project's file is read, and only its fenced, stamped, recent
// sections: hand-written heads and the legacy global pending-handoff.md are
// another lineage's artefacts and must not steer a new session.
export async function runPendingHandoffSource(
  input: PendingHandoffInput,
): Promise<PendingHandoffOutput> {
  if (!input.storageRoot) {
    return { result: { path: null, body: "", truncated: false }, warnings: [] };
  }
  const path = pendingHandoffPath(input.storageRoot, input.project);
  const text = await readIfExists(path);
  if (text === null) return { result: { path, body: "", truncated: false }, warnings: [] };

  const maxAgeMs = positiveNumberArg(input.args.max_age_days, DEFAULT_MAX_AGE_DAYS) * DAY_MS;
  const nowMs = input.now().getTime();
  const body = parsePendingHandoffSections(text)
    .filter((s) => s.writtenAt !== null && nowMs - s.writtenAt.getTime() <= maxAgeMs)
    .map((s) => s.body)
    .filter((b) => b.length > 0)
    .join("\n\n");

  const maxBytes = Math.floor(positiveNumberArg(input.args.max_bytes, DEFAULT_MAX_BYTES));
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= maxBytes) return { result: { path, body, truncated: false }, warnings: [] };
  return {
    result: {
      path,
      body: new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes), { stream: true }),
      truncated: true,
    },
    warnings: [
      `pending_handoff: ${path} exceeds max_bytes=${String(maxBytes)}; returning first ${String(maxBytes)} bytes`,
    ],
  };
}
