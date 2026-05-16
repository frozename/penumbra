import { readFileSync } from 'node:fs';

export interface StumbleEvidence {
  conv_ids: string[];
  commits: string[];
  files: string[];
  session_id: string;
}

export interface StumbleCandidate {
  prompt: string;
  affects_projects: string[];
  evidence: StumbleEvidence;
}

export type SessionEventRow = {
  event_type: string;
  payload_json: unknown;
};

export type SessionEventReader = (session_id: string) => Promise<SessionEventRow[]> | SessionEventRow[];

export interface ExtractStumblesInput {
  session_id: string;
  transcript_path?: string | null;
  dispatch_events_query?: SessionEventReader;
}

const STUMBLE_PATTERNS = [
  /(?:\bTODO\b|\bfollow[- ]?up\b|\bnext time\b|\bshould also\b|\bdeferred\b|\bout of scope\b|\bfuture\b)/i,
  /(?:revisit|audit|investigate|rework|tighten|refine|fix|document|verify|replace)\s+[^\n.]{3,80}/i,
  /(?:the eval cycle for|the review cycle for|the dispatch cycle for|the stop-hook for)\s+[^\n.]{3,80}/i,
];

function safeReadTranscript(transcriptPath: string): string {
  try {
    return readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
}

function hasStumbleSignal(line: string): boolean {
  return STUMBLE_PATTERNS.some((pattern) => pattern.test(line));
}

function normalizePrompt(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function buildCandidate(line: string, session_id: string): StumbleCandidate {
  const prompt = normalizePrompt(line);
  return {
    prompt,
    affects_projects: ['penumbra'],
    evidence: {
      conv_ids: [],
      commits: [],
      files: [],
      session_id,
    },
  };
}

function isDuplicateInlineFiling(candidate: StumbleCandidate, events: SessionEventRow[]): boolean {
  const needle = candidate.prompt.slice(0, 80);
  return events.some((event) => {
    if (event.event_type !== 'task_draft') return false;
    const payload = toRecord(event.payload_json);
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt : null;
    return typeof prompt === 'string' && prompt.slice(0, 80) === needle;
  });
}

function toRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      return toRecord(JSON.parse(input) as unknown);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function promptFromEvent(event: SessionEventRow): string | null {
  const payload = toRecord(event.payload_json);
  if (payload) {
    const candidate = payload.prompt ?? payload.text ?? payload.body ?? payload.full_summary ?? payload.summary;
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return null;
}

export async function extractStumblesFromSession(
  input: ExtractStumblesInput,
): Promise<StumbleCandidate[]> {
  const transcript = input.transcript_path ? safeReadTranscript(input.transcript_path) : '';
  const lines = transcript
    .split(/\r?\n+/)
    .map((line) => normalizePrompt(line))
    .filter((line) => line.length > 0);

  if (lines.length === 0 && !input.dispatch_events_query) return [];

  const candidates: StumbleCandidate[] = [];
  for (const line of lines) {
    if (!hasStumbleSignal(line)) continue;
    candidates.push(buildCandidate(line, input.session_id));
  }

  if (typeof input.dispatch_events_query === 'function') {
    const rows = await input.dispatch_events_query(input.session_id);
    const dedupeRows = Array.isArray(rows) ? rows : [];
    if (candidates.length === 0) {
      for (const row of dedupeRows) {
        const prompt = promptFromEvent(row);
        if (!prompt || !hasStumbleSignal(prompt)) continue;
        candidates.push(buildCandidate(prompt, input.session_id));
      }
    }
    return candidates.filter((candidate) => !isDuplicateInlineFiling(candidate, dedupeRows));
  }

  return candidates;
}
