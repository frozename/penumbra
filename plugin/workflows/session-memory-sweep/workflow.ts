import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

const DEFAULT_MAX_CANDIDATES = 10;
const MIN_TRANSCRIPT_CHARS = 200;
const FALLBACK_T2_PROMOTION_MIN_EVENTS = 5;

type Candidate = {
  action: "create" | "update";
  slug: string;
  update_existing_slug?: string;
  title: string;
  body: string;
  hook?: string | null;
  why: string;
  backlinks?: string[];
  durability?: string | null;
  is_episodic?: boolean | null;
};

type Args = {
  db?: Database;
  session_id?: string;
  project_id?: string | null;
  extractSessionCandidates?: (body: {
    session_id: string;
    project_id?: string | null;
    max_candidates: number;
  }) => Promise<{ candidates: Candidate[] }>;
};

const spec: WorkflowSpec = {
  name: "session-memory-sweep",
  description:
    "Extract close-time t2 memory candidates from the current session and render an approval-only block for next-session-prompt.",
  triggers: [
    { kind: "lifecycle", event: "pre-compact" },
    { kind: "lifecycle", event: "stop" },
  ],
  recall: [],
  output: [{ kind: "next-session-prompt" }],
  run: { kind: "ts-function" },
};

function resolveDb(ctx: { db?: () => Database; args?: Args; storageRoot: string }): {
  db: Database;
  shouldClose: boolean;
} {
  if (ctx.db) return { db: ctx.db(), shouldClose: false };
  if (ctx.args?.db) return { db: ctx.args.db, shouldClose: false };
  return {
    db: new Database(join(ctx.storageRoot, "db.sqlite"), { readonly: true }),
    shouldClose: true,
  };
}

function resolveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveDefaultMinEvents(): Promise<number> {
  try {
    const core = (await import("@penumbra/core")) as { DEFAULT_T2_PROMOTION_MIN_EVENTS?: unknown };
    if (typeof core.DEFAULT_T2_PROMOTION_MIN_EVENTS === "number") {
      return core.DEFAULT_T2_PROMOTION_MIN_EVENTS;
    }
  } catch {}
  return FALLBACK_T2_PROMOTION_MIN_EVENTS;
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

function findActiveTranscriptForCwd(
  db: Database,
  projectId: string | null,
): { sessionId: string; eventCount: number; transcript: string } | null {
  const row = db
    .query<{ session_id: string }, [string | null, string | null]>(
      `SELECT session_id
         FROM t0_events
        WHERE session_id IS NOT NULL
          AND (? IS NULL OR project_id = ?)
        GROUP BY session_id
        ORDER BY MAX(ts) DESC
        LIMIT 1`,
    )
    .get(projectId, projectId);
  if (!row?.session_id) return null;
  return readSessionTranscript(db, row.session_id);
}

function readSessionTranscript(
  db: Database,
  sessionId: string,
): { sessionId: string; eventCount: number; transcript: string } | null {
  const rows = db
    .query<
      { event_type: string; payload_summary: string | null; payload_json: string | null },
      [string]
    >("SELECT event_type, payload_summary, payload_json FROM t0_events WHERE session_id = ? ORDER BY ts ASC")
    .all(sessionId);
  if (rows.length === 0) return null;
  const transcript = rows
    .filter((row) => row.event_type === "agent-prompt" || row.event_type === "agent-response")
    .map((row) => {
      const role = row.event_type === "agent-prompt" ? "User" : "Assistant";
      const content = pickTranscriptContent(row.payload_summary, row.payload_json);
      return content ? `${role}: ${content}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
  return { sessionId, eventCount: rows.length, transcript };
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const root = resolveStorageRoot(storageRoot);
  const port = readFileSync(join(root, "port"), "utf8").trim();
  const token = readFileSync(join(root, "token"), "utf8").trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`session-memory-sweep: invalid daemon port in ${join(root, "port")}`);
  }
  if (!token) throw new Error(`session-memory-sweep: empty daemon token in ${join(root, "token")}`);
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function resolveStorageRoot(storageRoot: string): string {
  if (
    storageRoot &&
    existsSync(join(storageRoot, "port")) &&
    existsSync(join(storageRoot, "token"))
  ) {
    return storageRoot;
  }
  const env = process.env.PENUMBRA_STORAGE_ROOT;
  if (env && existsSync(join(env, "port")) && existsSync(join(env, "token"))) return env;
  for (const candidate of [join(homedir(), ".penumbra"), "/tmp/penumbra-live"]) {
    if (existsSync(join(candidate, "port")) && existsSync(join(candidate, "token"))) {
      return candidate;
    }
  }
  return storageRoot;
}

async function fetchCandidates(
  storageRoot: string,
  body: { session_id: string; project_id?: string | null; max_candidates: number },
): Promise<{ candidates: Candidate[] }> {
  const daemon = resolveDaemon(storageRoot);
  const res = await fetch(`${daemon.baseUrl}/memory/session-extract`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`session-memory-sweep: /memory/session-extract -> ${res.status} ${text}`);
  }
  return (await res.json()) as { candidates: Candidate[] };
}

function renderCandidate(candidate: Candidate, index: number): string {
  const slug =
    candidate.action === "update" && candidate.update_existing_slug
      ? candidate.update_existing_slug
      : candidate.slug;
  const backlinks = candidate.backlinks?.length ? candidate.backlinks.join(", ") : "none";
  return [
    `${index}. [${candidate.action}] ${candidate.title}`,
    `   - slug: ${slug}`,
    `   - hook: ${candidate.hook ?? candidate.title}`,
    `   - why: ${candidate.why}`,
    `   - backlinks: ${backlinks}`,
    "   - body:",
    ...candidate.body.split(/\r?\n/).map((line) => `     ${line}`),
  ].join("\n");
}

function renderCandidates(candidates: Candidate[]): string {
  if (candidates.length === 0) return "no new candidates";
  return ["## Session memory candidates", "", ...candidates.map(renderCandidate)].join("\n\n");
}

export const fn: WorkflowFn<Args> = async (ctx) => {
  if (process.env.PENUMBRA_SESSION_SWEEP_ENABLED === "0") return "";

  const { db, shouldClose } = resolveDb(ctx);
  const projectId = ctx.args.project_id ?? ctx.project ?? null;
  const sessionId = ctx.args.session_id;
  const maxCandidates = resolveIntEnv(
    "PENUMBRA_SESSION_SWEEP_MAX_CANDIDATES",
    DEFAULT_MAX_CANDIDATES,
  );

  let transcript: { sessionId: string; eventCount: number; transcript: string } | null;
  try {
    transcript = sessionId
      ? readSessionTranscript(db, sessionId)
      : findActiveTranscriptForCwd(db, projectId);
  } finally {
    if (shouldClose) db.close();
  }

  if (!transcript) return "";
  if (transcript.transcript.length < MIN_TRANSCRIPT_CHARS) return "";
  const minEvents = resolveIntEnv(
    "PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS",
    await resolveDefaultMinEvents(),
  );
  if (transcript.eventCount < minEvents) return "";

  const extract =
    ctx.args.extractSessionCandidates ?? ((body) => fetchCandidates(ctx.storageRoot, body));
  const result = await extract({
    session_id: transcript.sessionId,
    project_id: projectId,
    max_candidates: maxCandidates,
  });
  if (result.candidates.length === 0) return "";
  return renderCandidates(result.candidates.slice(0, maxCandidates));
};

export default spec;
