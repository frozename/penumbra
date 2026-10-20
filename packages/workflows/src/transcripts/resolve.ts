import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ReadCodexTranscriptOptions,
  ResolveSessionTranscriptInput,
  ResolveSessionTranscriptResult,
  TranscriptReadResult,
} from "./types.js";

import { readCodexTranscript } from "./codex.js";

export type ResolveSessionTranscriptDeps = {
  readTranscript?: (options: ReadCodexTranscriptOptions) => Promise<TranscriptReadResult>;
};

function unsupported(reason: string): ResolveSessionTranscriptResult {
  return { status: "unsupported", reason };
}

function unavailable(reason = "Transcript unavailable"): ResolveSessionTranscriptResult {
  return { status: "unavailable", reason };
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function validateInput(
  input: ResolveSessionTranscriptInput,
): ResolveSessionTranscriptResult | null {
  if (
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    typeof input.projectId !== "string" ||
    input.projectId.length === 0 ||
    typeof input.cwd !== "string" ||
    !isAbsolute(input.cwd) ||
    typeof input.format !== "string" ||
    input.format.length === 0 ||
    input.allowedRoots.length === 0 ||
    input.allowedRoots.some((root) => !isAbsolute(root) || resolve(root) !== root)
  ) {
    return unsupported("Invalid session transcript resolver options");
  }
  if (input.path === undefined || input.path === null || input.path.length === 0) {
    return unavailable();
  }
  if (!isAbsolute(input.path)) {
    return { status: "scope_violation", reason: "Transcript path is outside trusted roots" };
  }
  return null;
}

export async function resolveSessionTranscript(
  input: ResolveSessionTranscriptInput,
  deps: ResolveSessionTranscriptDeps = {},
): Promise<ResolveSessionTranscriptResult> {
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const transcriptPath = input.path;
  if (!transcriptPath) return unavailable();

  let canonicalCwd: string;
  let canonicalCandidate: string;
  let canonicalRoots: string[];
  try {
    [canonicalCwd, canonicalCandidate, canonicalRoots] = await Promise.all([
      realpath(input.cwd),
      realpath(transcriptPath),
      Promise.all(input.allowedRoots.map(async (root) => await realpath(root))),
    ]);
  } catch {
    return unavailable();
  }

  if (!canonicalRoots.some((root) => isContained(root, canonicalCandidate))) {
    return { status: "scope_violation", reason: "Transcript path is outside trusted roots" };
  }

  let target: Awaited<ReturnType<typeof stat>>;
  try {
    target = await stat(canonicalCandidate, { bigint: true });
  } catch {
    return unavailable();
  }
  if (!target.isFile()) return unavailable("Transcript path is not a regular file");

  return await (deps.readTranscript ?? readCodexTranscript)({
    path: canonicalCandidate,
    expectedSessionId: input.sessionId,
    expectedCwd: canonicalCwd,
    format: input.format,
    expectedFileIdentity: { dev: target.dev, ino: target.ino },
  });
}
