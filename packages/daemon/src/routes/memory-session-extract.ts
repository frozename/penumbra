import { extractSessionCandidates, type Services } from "@penumbra/core";
import { closeSync, fstatSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { z } from "zod";

import { resolveT2ExtractionJudge } from "../workers/t2-promotion.js";
import { bodyJson, json } from "./_helpers.js";

const MAX_TRANSCRIPT_FILE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_FILE_TAIL_BYTES = 262_144;

const MemorySessionExtractSchema = z
  .object({
    session_id: z.string().min(1).max(200),
    transcript_path: z.string().min(1).optional(),
    project_id: z.string().nullable().optional(),
    max_candidates: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export async function memorySessionExtractRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }
  const parsed = MemorySessionExtractSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((issue) => ({
            path: issue.path.map((part) => String(part)),
            message: issue.message,
          })),
        },
      },
      400,
    );
  }

  const judge = resolveT2ExtractionJudge(services);
  if (!judge) {
    return json(
      {
        error: {
          code: "judge_unconfigured",
          message: "memory session extraction requires a configured LLM judge",
        },
      },
      503,
    );
  }

  const transcript = readSessionTranscript(
    services,
    parsed.data.session_id,
    parsed.data.transcript_path,
  );
  let candidates: Awaited<ReturnType<typeof extractSessionCandidates>>;
  try {
    candidates = await extractSessionCandidates(
      {
        db: services.db,
        embedder: services.embedder,
        llm: judge,
        project_id: parsed.data.project_id ?? null,
        maxCandidates: parsed.data.max_candidates,
      },
      transcript,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    services.log.warn({ err }, "memory session extraction judge failed");
    return json(
      {
        error: {
          code: "judge_failed",
          message,
        },
      },
      502,
    );
  }

  return json({
    candidates: candidates.map(({ embedding: _embedding, ...candidate }) => candidate),
  });
}

function readSessionTranscript(
  services: Services,
  sessionId: string,
  transcriptPath: string | undefined,
): string {
  if (transcriptPath) {
    const fromClaude = readClaudeTranscript(transcriptPath);
    if (fromClaude !== null) {
      return fromClaude;
    }
  }

  const events = services.db
    .query<
      { event_type: string; payload_summary: string | null; payload_json: string | null },
      [string]
    >("SELECT event_type, payload_summary, payload_json FROM t0_events WHERE session_id = ? ORDER BY ts ASC")
    .all(sessionId);

  return events
    .filter((event) => event.event_type === "agent-prompt" || event.event_type === "agent-response")
    .map((event) => {
      const role = event.event_type === "agent-prompt" ? "User" : "Assistant";
      const content = pickTranscriptContent(event.payload_summary, event.payload_json);
      return content ? `${role}: ${content}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function readClaudeTranscript(path: string): string | null {
  if (!isReadableFile(path)) return null;
  const content = readFileHeadTail(path, MAX_TRANSCRIPT_FILE_BYTES, MAX_TRANSCRIPT_FILE_TAIL_BYTES);
  if (content === null) return null;
  return parseClaudeTranscript(content);
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readFileHeadTail(path: string, maxBytes: number, tailBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stats: Stats = fstatSync(fd);
    const fileSize = stats.size;
    if (fileSize <= 0) return "";
    if (fileSize <= maxBytes) {
      const buf = Buffer.alloc(fileSize);
      const bytesRead = readSync(fd, buf, 0, fileSize, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    }

    const headBytes = Math.max(1, maxBytes - tailBytes);
    const head = Buffer.alloc(headBytes);
    const headBytesRead = readSync(fd, head, 0, headBytes, 0);

    const safeTailBytes = Math.min(tailBytes, maxBytes - headBytesRead);
    const tailOffset = Math.max(0, fileSize - safeTailBytes);
    const tail = Buffer.alloc(safeTailBytes);
    const tailBytesRead = readSync(fd, tail, 0, safeTailBytes, tailOffset);

    const headText = head.subarray(0, headBytesRead).toString("utf8").trimStart();
    const tailText = tail.subarray(0, tailBytesRead).toString("utf8").trimEnd();
    return `${headText}\n\n…\n\n${tailText}`.trim();
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (_: unknown) {
        void _;
      }
    }
  }
}

function pushTextLines(rows: string[], role: string, text: string[]): void {
  for (const item of text) rows.push(`${role}: ${item}`);
}

function parseClaudeTranscript(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const rows: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseJsonLine(trimmed);
    if (!entry) continue;

    const role = normalizeRole(
      readMessageField(entry, ["role"]) ?? readMessageField(entry, ["message", "role"]),
    );
    if (!role) continue;

    const message = readMessageField(entry, ["message"]) ?? entry;
    const content = readMessageField(message, ["content"]);
    const text = extractTextBlocks(content).map(scrubTranscriptMarkup).filter(Boolean);
    pushTextLines(rows, role, text);

    if (text.length > 0) continue;

    const fallback = extractTextBlocks(message).join(" ");
    const fixedFallback = scrubTranscriptMarkup(fallback);
    if (fixedFallback) rows.push(`${role}: ${fixedFallback}`);
  }

  return rows.join("\n\n");
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readMessageField(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    const record = current as Record<string, unknown>;
    current = record[key];
  }
  return current;
}

function normalizeRole(value: unknown): "User" | "Assistant" | null {
  if (typeof value !== "string") return null;
  const role = value.toLowerCase();
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return null;
}

function extractTextBlocks(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    return [value.trim()].filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractTextFromBlock).filter(Boolean);
  }
  if (typeof value === "object") {
    const message = value as Record<string, unknown>;
    const role = normalizeRole(message.role);
    if (role && typeof message.content === "string") return [message.content];
    if (Array.isArray(message.content))
      return message.content.flatMap(extractTextFromBlock).filter(Boolean);
    const direct = message.text ?? message.message;
    if (typeof direct === "string") return [direct];
    return [];
  }
  return [];
}

function extractTextFromBlock(block: unknown): string[] {
  if (!block || typeof block !== "object") return [];
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type && type !== "text") return [];
  const text = readMessageField(record, ["text"]);
  if (typeof text === "string") return [text];
  if (text && typeof text === "object") {
    const nested = readMessageField(text, ["text"]);
    if (typeof nested === "string") return [nested];
  }
  if (record.content && typeof record.content === "string") return [record.content];
  return [];
}

function pickTranscriptContent(payloadSummary: string | null, payloadJson: string | null): string {
  const summary = scrubTranscriptMarkup((payloadSummary ?? "").trim());
  if (summary) return summary;
  if (!payloadJson) return "";
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return scrubTranscriptMarkup(extractPayloadText(parsed).trim());
  } catch {
    return "";
  }
}

function extractPayloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return (
    readString(record.text) ??
    readString(record.message) ??
    readString(record.prompt) ??
    readString(record.message_excerpt) ??
    readString(record.response) ??
    extractResponseText(record.response) ??
    extractInputText(record.input) ??
    ""
  );
}

function extractResponseText(response: unknown): string | null {
  if (typeof response === "string") return response;
  if (Array.isArray(response) && response.length > 0) {
    const first = (response as unknown[])[0];
    if (first && typeof first === "object")
      return readString((first as Record<string, unknown>).text);
  }
  if (response && typeof response === "object") {
    return readString((response as Record<string, unknown>).text);
  }
  return null;
}

function extractInputText(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return readString(record.text) ?? readString(record.message) ?? readString(record.prompt);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function scrubTranscriptMarkup(content: string): string {
  if (!content) return "";
  return content
    .replaceAll(/<\/?(?:function_calls|invoke|tool_call|tool_use|antml:[a-z_]+)\b[^>]*>/gi, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}
