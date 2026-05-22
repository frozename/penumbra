import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import { createResearchAdapter } from '../research/firecrawl-adapter.js';
import type { DreamCycleDeps } from './cycle.js';

export function buildDreamCycleDeps(
  services: {
    projectRegistry?: { get(id: string): any; list(): any[] };
    embedder?: { embed(bodies: string[]): Promise<Float32Array[]> };
  },
  db: Database,
): DreamCycleDeps {
  const researchProvider = process.env.FIRECRAWL_API_KEY ? 'firecrawl' : 'webfetch';
  const researchAdapter = createResearchAdapter({ provider: researchProvider as 'firecrawl' | 'webfetch' });

  const memoryObserve = async (
    briefMarkdown: string,
    projectId: string,
    cycleId: string,
  ): Promise<{ memory_id: string }> => {
    const memory_id = randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, ?, 'system', 'brief', ?, ?, ?, ?, ?, ?)`,
    ).run(memory_id, projectId, nowIso, nowIso, `Brief: ${projectId} (${cycleId.slice(0, 8)})`, briefMarkdown, nowIso, nowIso);
    return { memory_id };
  };

  const deps: DreamCycleDeps = {
    projectRegistry: services.projectRegistry,
    researchAdapter,
    memoryObserve,
  };

  if (services.embedder) {
    deps.onReembed = async (_id: string, body: string) => (await services.embedder!.embed([body]))[0]!;
  }

  return deps;
}
