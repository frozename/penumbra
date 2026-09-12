import { type Services, stripPrivacyTags } from "@penumbra/core";
import { resolveSessionTranscript, type ResolveSessionTranscriptResult } from "@penumbra/workflows";
import { homedir } from "node:os";
import { join } from "node:path";

const QUALIFIED_CODEX_TRANSCRIPT_FORMAT = "penumbra-codex-rollout-fixture-v1";
const MIN_TRANSCRIPT_CHARS = 200;
const CAPTURED_CODEX_HOME = process.env.CODEX_HOME?.trim() ?? join(homedir(), ".codex");

export type CodexTranscriptServerContext = {
  codexSessionsRoot: string;
};

export const DEFAULT_CODEX_TRANSCRIPT_SERVER_CONTEXT: CodexTranscriptServerContext = {
  codexSessionsRoot: join(CAPTURED_CODEX_HOME, "sessions"),
};

export type PreparedCodexTranscript =
  | { status: "ready"; transcript: string; source: "t0" | "transcript_path"; truncated: boolean }
  | { status: "insufficient_data"; reason: string }
  | {
      status: "error";
      httpStatus: 403 | 422;
      code:
        | "unsupported_transcript"
        | "transcript_identity_mismatch"
        | "transcript_scope_violation";
      message: string;
    };

type SessionEvidenceRow = {
  project_id: string | null;
  cwd: string | null;
  meta_json: string | null;
};

type SessionEvidence = SessionEvidenceRow & {
  transcriptFormat: unknown;
};

type T0TranscriptRow = {
  event_type: string;
  payload_summary: string | null;
  payload_json: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trustedRootIngress(metaJson: string | null): Record<string, unknown> | null {
  if (!metaJson) return null;
  try {
    const meta: unknown = JSON.parse(metaJson);
    if (!isRecord(meta) || !isRecord(meta.ingress)) return null;
    const ingress = meta.ingress;
    return ingress.harness === "codex" &&
      ingress.role === "maestro" &&
      ingress.lineage === "root" &&
      (ingress.provenance === "verified-launch" ||
        ingress.provenance === "verified-session-correlation") &&
      ingress.is_child === false &&
      ingress.parent_session_id === null
      ? ingress
      : null;
  } catch {
    return null;
  }
}

function currentSessionEvidence(services: Services, sessionId: string): SessionEvidence | null {
  const rows = services.db
    .query<SessionEvidenceRow, [string]>(
      `SELECT project_id, cwd, meta_json
       FROM session_events
       WHERE session_id = ?
         AND kind IN ('session.start', 'session.pre_compact', 'session.stop', 'session.end')
       ORDER BY ts DESC, id DESC
       LIMIT 100`,
    )
    .all(sessionId);
  for (const row of rows) {
    const ingress = trustedRootIngress(row.meta_json);
    if (ingress) return { ...row, transcriptFormat: ingress.transcript_format };
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function payloadText(payloadJson: string | null): string {
  if (!payloadJson) return "";
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed === "string") return parsed;
    if (!isRecord(parsed)) return "";
    const response = parsed.response;
    const input = parsed.input;
    return (
      readString(parsed.text) ??
      readString(parsed.message) ??
      readString(parsed.prompt) ??
      readString(parsed.message_excerpt) ??
      readString(response) ??
      (isRecord(response) ? readString(response.text) : null) ??
      (isRecord(input)
        ? (readString(input.text) ?? readString(input.message) ?? readString(input.prompt))
        : null) ??
      ""
    );
  } catch {
    return "";
  }
}

function scrub(content: string): string {
  return stripPrivacyTags(content).replaceAll(/\s+/g, " ").trim();
}

function normalizedT0Transcript(
  services: Services,
  sessionId: string,
  projectId: string,
): string | null {
  const rows = services.db
    .query<T0TranscriptRow, [string, string]>(
      `SELECT event_type, payload_summary, payload_json
       FROM t0_events
       WHERE project_id = ?
         AND session_id = ?
         AND source = 'codex'
         AND event_type IN ('agent-prompt', 'agent-response')
       ORDER BY ts ASC, event_id ASC`,
    )
    .all(projectId, sessionId);
  let hasUser = false;
  let hasAssistant = false;
  const lines: string[] = [];
  for (const row of rows) {
    const summary = row.payload_summary?.trim();
    const content = scrub(summary?.length ? summary : payloadText(row.payload_json));
    if (!content) continue;
    if (row.event_type === "agent-prompt") hasUser = true;
    else hasAssistant = true;
    lines.push(`${row.event_type === "agent-prompt" ? "User" : "Assistant"}: ${content}`);
  }
  const transcript = lines.join("\n\n");
  return hasUser && hasAssistant && transcript.length >= MIN_TRANSCRIPT_CHARS ? transcript : null;
}

function messagesToTranscript(
  messages: readonly { role: "user" | "assistant"; text: string }[],
): string | null {
  const hasUser = messages.some((message) => message.role === "user" && message.text.length > 0);
  const hasAssistant = messages.some(
    (message) => message.role === "assistant" && message.text.length > 0,
  );
  const transcript = messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${scrub(message.text)}`)
    .join("\n\n");
  return hasUser && hasAssistant && transcript.length >= MIN_TRANSCRIPT_CHARS ? transcript : null;
}

export async function prepareCodexSessionTranscript(opts: {
  services: Services;
  sessionId: string;
  projectId: string;
  transcriptPath?: string;
  transcriptFormat?: string | null;
  serverContext?: CodexTranscriptServerContext;
}): Promise<PreparedCodexTranscript> {
  if (opts.transcriptFormat !== QUALIFIED_CODEX_TRANSCRIPT_FORMAT) {
    return {
      status: "error",
      httpStatus: 422,
      code: "unsupported_transcript",
      message: "Unsupported Codex transcript format",
    };
  }

  const evidence = currentSessionEvidence(opts.services, opts.sessionId);
  if (evidence?.project_id !== opts.projectId || !evidence.cwd) {
    return {
      status: "error",
      httpStatus: 403,
      code: "transcript_scope_violation",
      message: "Current Codex session evidence does not match the requested project",
    };
  }
  if (evidence.transcriptFormat !== QUALIFIED_CODEX_TRANSCRIPT_FORMAT) {
    return {
      status: "error",
      httpStatus: 422,
      code: "unsupported_transcript",
      message: "Current Codex session evidence has an unsupported transcript format",
    };
  }

  const normalized = normalizedT0Transcript(opts.services, opts.sessionId, opts.projectId);
  if (normalized) {
    return { status: "ready", transcript: normalized, source: "t0", truncated: false };
  }

  const resolved: ResolveSessionTranscriptResult = await resolveSessionTranscript({
    harness: "codex",
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    cwd: evidence.cwd,
    path: opts.transcriptPath,
    format: opts.transcriptFormat,
    allowedRoots: [
      (opts.serverContext ?? DEFAULT_CODEX_TRANSCRIPT_SERVER_CONTEXT).codexSessionsRoot,
    ],
  });
  if (resolved.status === "scope_violation") {
    return {
      status: "error",
      httpStatus: 403,
      code: "transcript_scope_violation",
      message: resolved.reason,
    };
  }
  if (resolved.status === "unsupported") {
    return {
      status: "error",
      httpStatus: 422,
      code: "unsupported_transcript",
      message: resolved.reason,
    };
  }
  if (resolved.status === "identity_mismatch") {
    return {
      status: "error",
      httpStatus: 422,
      code: "transcript_identity_mismatch",
      message: resolved.reason,
    };
  }
  if (resolved.status === "unavailable") {
    return { status: "insufficient_data", reason: resolved.reason };
  }
  const transcript = messagesToTranscript(resolved.messages);
  if (!transcript) {
    return {
      status: "insufficient_data",
      reason: "Codex transcript lacks adequate user and assistant observations",
    };
  }
  return {
    status: "ready",
    transcript,
    source: "transcript_path",
    truncated: resolved.truncated,
  };
}
