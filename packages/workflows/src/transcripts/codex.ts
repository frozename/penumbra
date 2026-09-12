import { stripPrivacyTags } from "@penumbra/core";
import { type BigIntStats, constants, realpathSync } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  ReadCodexTranscriptOptions,
  TranscriptMessage,
  TranscriptReadResult,
} from "./types.js";

const SUPPORTED_FORMAT = "penumbra-codex-rollout-fixture-v1";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENTS = 2_000;
const IDENTITY_HEADER_MAX_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 16 * 1024;

type JsonObject = Record<string, unknown>;

type ValidIdentity = {
  sessionId: string;
  cwd: string;
};

type IdentityResult =
  | { ok: true; identity: ValidIdentity }
  | { ok: false; result: TranscriptReadResult };

type ParseState = {
  identity: ValidIdentity | null;
  messages: TranscriptMessage[];
  messageEvents: number;
  eventTruncated: boolean;
  failure: TranscriptReadResult | null;
};

type LineAccumulator = {
  chunks: Buffer[];
  bytes: number;
};

type TextBlock = JsonObject & { text: string };

function unsupported(reason: string): TranscriptReadResult {
  return { status: "unsupported", reason };
}

function identityMismatch(reason: string): TranscriptReadResult {
  return { status: "identity_mismatch", reason };
}

function unavailable(reason = "Transcript unavailable"): TranscriptReadResult {
  return { status: "unavailable", reason };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(line: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTextBlock(block: unknown, expectedType: string): block is TextBlock {
  return isJsonObject(block) && block.type === expectedType && typeof block.text === "string";
}

function validateIdentity(record: JsonObject, options: ReadCodexTranscriptOptions): IdentityResult {
  if (record.type !== "session_meta" || !isJsonObject(record.payload)) {
    return { ok: false, result: unsupported("Invalid Codex transcript identity header") };
  }

  const payload = record.payload;
  const { id, session_id: sessionId, cwd, originator, cli_version: cliVersion, source } = payload;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    originator !== "codex_exec" ||
    cliVersion !== "0.153.4" ||
    source !== "exec"
  ) {
    return { ok: false, result: unsupported("Unsupported Codex transcript metadata") };
  }
  if (id !== sessionId) {
    return { ok: false, result: identityMismatch("Conflicting Codex session identity") };
  }
  if (sessionId !== options.expectedSessionId) {
    return { ok: false, result: identityMismatch("Codex session identity mismatch") };
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    return { ok: false, result: identityMismatch("Codex transcript cwd is unavailable") };
  }
  if (canonicalCwd !== options.expectedCwd) {
    return { ok: false, result: identityMismatch("Codex transcript cwd mismatch") };
  }
  return { ok: true, identity: { sessionId, cwd: canonicalCwd } };
}

function extractMessage(record: JsonObject): TranscriptMessage | null {
  if (record.type !== "response_item" || !isJsonObject(record.payload)) return null;
  const payload = record.payload;
  if (payload.type !== "message") return null;
  if (payload.role !== "user" && payload.role !== "assistant") return null;
  if (!Array.isArray(payload.content)) return null;

  const expectedBlockType = payload.role === "user" ? "input_text" : "output_text";
  const text = payload.content
    .filter((block): block is TextBlock => isTextBlock(block, expectedBlockType))
    .map((block) => block.text)
    .join("");
  if (text.length === 0) return null;
  return { role: payload.role, text: stripPrivacyTags(text) };
}

function processContentLine(line: string, state: ParseState, maxEvents: number): void {
  const record = parseJsonObject(line);
  if (!record) return;
  if (record.type === "session_meta") {
    state.failure = unsupported("Repeated Codex transcript identity header");
    return;
  }

  const extracted = extractMessage(record);
  if (!extracted) return;
  state.messageEvents++;
  if (state.messageEvents > maxEvents) {
    state.eventTruncated = true;
    return;
  }
  state.messages.push(extracted);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function pathSnapshot(path: string): Promise<BigIntStats> {
  return await lstat(path, { bigint: true });
}

function appendSegment(accumulator: LineAccumulator, segment: Buffer): void {
  if (segment.length === 0) return;
  accumulator.chunks.push(segment);
  accumulator.bytes += segment.length;
}

function finishLine(
  accumulator: LineAccumulator,
  state: ParseState,
  options: ReadCodexTranscriptOptions,
  maxEvents: number,
): void {
  const line = Buffer.concat(accumulator.chunks, accumulator.bytes).toString("utf8");
  accumulator.chunks = [];
  accumulator.bytes = 0;
  if (state.identity) {
    processContentLine(line, state, maxEvents);
    return;
  }

  const header = parseJsonObject(line);
  if (!header) {
    state.failure = unsupported("Invalid Codex transcript identity header");
    return;
  }
  const identityResult = validateIdentity(header, options);
  if (!identityResult.ok) {
    state.failure = identityResult.result;
    return;
  }
  state.identity = identityResult.identity;
}

function consumeChunk(
  chunk: Buffer,
  accumulator: LineAccumulator,
  state: ParseState,
  options: ReadCodexTranscriptOptions,
  maxEvents: number,
): void {
  let chunkOffset = 0;
  while (chunkOffset < chunk.length) {
    const newline = chunk.indexOf(0x0a, chunkOffset);
    const end = newline === -1 ? chunk.length : newline;
    appendSegment(accumulator, chunk.subarray(chunkOffset, end));
    if (!state.identity && accumulator.bytes > IDENTITY_HEADER_MAX_BYTES) {
      state.failure = unsupported("Codex transcript identity header exceeds 64 KiB");
      return;
    }
    if (newline === -1) return;
    finishLine(accumulator, state, options, maxEvents);
    if (state.failure) return;
    chunkOffset = newline + 1;
  }
}

async function readBoundedTranscript(
  handle: FileHandle,
  initialSize: bigint,
  options: ReadCodexTranscriptOptions,
  maxBytes: number,
  maxEvents: number,
): Promise<TranscriptReadResult> {
  const state: ParseState = {
    identity: null,
    messages: [],
    messageEvents: 0,
    eventTruncated: false,
    failure: null,
  };
  let position = 0;
  const accumulator: LineAccumulator = { chunks: [], bytes: 0 };

  while (position < maxBytes && !state.failure) {
    const requested = Math.min(READ_CHUNK_BYTES, maxBytes - position);
    const buffer = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) break;
    position += bytesRead;

    const chunk = buffer.subarray(0, bytesRead);
    consumeChunk(chunk, accumulator, state, options, maxEvents);
  }

  if (state.failure) return state.failure;
  if (!state.identity) {
    return unsupported("Incomplete Codex transcript identity header");
  }

  return {
    status: "ok",
    sessionId: state.identity.sessionId,
    cwd: state.identity.cwd,
    messages: state.messages,
    truncated: state.eventTruncated || BigInt(position) < initialSize,
    contextTokens: null,
  };
}

function validateOptions(options: ReadCodexTranscriptOptions): TranscriptReadResult | null {
  if (options.format !== SUPPORTED_FORMAT) {
    return unsupported("Unsupported Codex transcript format");
  }
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
  ) {
    return unsupported("Invalid maxBytes");
  }
  if (
    options.maxEvents !== undefined &&
    (!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0)
  ) {
    return unsupported("Invalid maxEvents");
  }
  if (
    typeof options.path !== "string" ||
    options.path.length === 0 ||
    typeof options.expectedSessionId !== "string" ||
    options.expectedSessionId.length === 0 ||
    typeof options.expectedCwd !== "string" ||
    !isAbsolute(options.expectedCwd) ||
    resolve(options.expectedCwd) !== options.expectedCwd
  ) {
    return unsupported("Invalid Codex transcript reader options");
  }
  return null;
}

export async function readCodexTranscript(
  options: ReadCodexTranscriptOptions,
): Promise<TranscriptReadResult> {
  const invalid = validateOptions(options);
  if (invalid) return invalid;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  let handle: FileHandle;
  try {
    handle = await open(
      options.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return unavailable();
  }

  let result: TranscriptReadResult;
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile()) {
      result = unavailable("Transcript path is not a regular file");
    } else {
      const pathBefore = await pathSnapshot(options.path);
      if (!pathBefore.isFile() || !sameSnapshot(descriptorBefore, pathBefore)) {
        result = unavailable("Transcript path identity changed before reading");
      } else {
        result = await readBoundedTranscript(
          handle,
          descriptorBefore.size,
          options,
          maxBytes,
          maxEvents,
        );
        const descriptorAfter = await handle.stat({ bigint: true });
        const pathAfter = await pathSnapshot(options.path);
        if (
          !sameSnapshot(descriptorBefore, descriptorAfter) ||
          !sameSnapshot(descriptorBefore, pathAfter)
        ) {
          result = unavailable("Transcript changed while reading");
        }
      }
    }
  } catch {
    result = unavailable();
  }

  try {
    await handle.close();
  } catch {
    return unavailable("Transcript descriptor could not be closed safely");
  }
  return result;
}
