import type { Services } from '@penumbra/core';
import { ConversationStreamEventSchema } from '@penumbra/core';
import { json } from './_helpers.js';
const DEFAULT_TERMINAL_PROGRESS_CAP = 50;
const TERMINAL_PROGRESS_CAP_TTL_MS = 60 * 60 * 1000;
const NON_TERMINAL_HANDOFF_STATUSES = new Set(['pending', 'approved', 'redirected', 'dispatched']);

type TerminalProgressState = {
  count: number;
  last_ts: number;
};

const terminalProgressState = new Map<string, TerminalProgressState>();

/**
 * POST /handoffs/:id/progress
 * Invoked by workers to push buffered progress deltas or final hop results.
 */
export async function handoffsProgressRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }

  const parsed = ConversationStreamEventSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const row = services.handoffReader.get(handoff_id);
  if (!row) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  }

  if (!NON_TERMINAL_HANDOFF_STATUSES.has(row.status)) {
    const capCheck = checkTerminalProgressCap(handoff_id, services.clock().getTime());
    if (capCheck !== null) {
      return capCheck;
    }
  }

  // Broadcast to live subscribers and store in transient memory cache.
  services.conversationStream.emit(row.conversation_id, parsed.data);

  return json({ ok: true });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}

function checkTerminalProgressCap(handoff_id: string, nowTs: number): Response | null {
  evictStaleTerminalProgressState(nowTs);

  const cap = getTerminalProgressCap();
  const next = (terminalProgressState.get(handoff_id)?.count ?? 0) + 1;
  terminalProgressState.set(handoff_id, { count: next, last_ts: nowTs });

  if (next > cap) {
    return json({
      error: {
        code: 'progress_cap_exceeded',
        message: `terminal handoff ${handoff_id} exceeded the progress cap of ${cap}`,
      },
    }, 429);
  }

  return null;
}

function evictStaleTerminalProgressState(nowTs: number): void {
  const cutoff = nowTs - TERMINAL_PROGRESS_CAP_TTL_MS;
  for (const [handoff_id, entry] of terminalProgressState) {
    if (entry.last_ts < cutoff) {
      terminalProgressState.delete(handoff_id);
    }
  }
}

function getTerminalProgressCap(): number {
  const raw = process.env.PENUMBRA_TERMINAL_PROGRESS_CAP;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TERMINAL_PROGRESS_CAP;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TERMINAL_PROGRESS_CAP;
}

