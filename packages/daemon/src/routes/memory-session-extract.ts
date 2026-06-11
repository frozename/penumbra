import { z } from "zod";
import { extractSessionCandidates, type Services } from "@penumbra/core";
import { resolveT2ExtractionJudge } from "../workers/t2-promotion.js";
import { bodyJson, json } from "./_helpers.js";

const MemorySessionExtractSchema = z
  .object({
    session_id: z.string().min(1).max(200),
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

  const transcript = readSessionTranscript(services, parsed.data.session_id);
  const candidates = await extractSessionCandidates(
    {
      db: services.db,
      embedder: services.embedder,
      llm: judge,
      project_id: parsed.data.project_id ?? null,
      maxCandidates: parsed.data.max_candidates,
    },
    transcript,
  );

  return json({
    candidates: candidates.map(({ embedding: _embedding, ...candidate }) => candidate),
  });
}

function readSessionTranscript(services: Services, sessionId: string): string {
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
    const first = response[0];
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
    .replace(/<\/?(?:function_calls|invoke|tool_call|tool_use|antml:[a-z_]+)\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
