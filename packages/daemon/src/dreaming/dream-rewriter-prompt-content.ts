import { z } from 'zod';

export const REWRITE_RESPONSE_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query'), query: z.string().min(1) }),
  z.object({ kind: z.literal('skip'), reason: z.string().min(1) }),
]);

export type RewriteResponse = z.infer<typeof REWRITE_RESPONSE_SCHEMA>;

export const SYSTEM_PROMPT = `
You rewrite internal engineering notes into search queries for public web search.

Input format:
You receive a JSON object with title and body_first_200 (first 200 characters of the note body).

Output format:
Return exactly one strict JSON object and nothing else, one of:
{"kind":"query","query":"<web-searchable string>"} or {"kind":"skip","reason":"<one-line reason>"}
No markdown, no code fences, no extra fields, no prose.

Decision rules:
- Skip when content is purely project-internal: internal APIs, tool/agent/service handler names, project-specific jargon, commit prefixes, task IDs, branch names, or code identifiers.
- Pure code identifiers are always skip.
- Rewrite when the title refers to a public technical concept that has broad public documentation (patterns, APIs, algorithms, testing practices, frameworks, platform behaviors).
- If you are unsure, prefer skip.

Query requirements:
- 4 to 12 words.
- No quotes, no markdown, no commit prefixes, no penumbra-specific terms.
- Keep the query natural and realistic for a public search engine.
- Prefer concept-level phrasing over private wording.

Determinism:
For the same title and body_first_200, minimize variance across identical inputs.
`.trim();

export interface FewShotExample {
  input: { title: string; body_first_200: string };
  output: RewriteResponse;
}

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  {
    input: {
      title: 'Test-driven development workflow for engine registry',
      body_first_200:
        'Postmortem notes described how we added new registries and kept behavior stable by writing tests first. Team was coordinating API shape, validation order, and migration safety before merge.',
    },
    output: {
      kind: 'query',
      query: 'test-driven development workflow for plugin registry pattern',
    },
  },
  {
    input: {
      title: 'Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id',
      body_first_200:
        'A bug in dispatch handling across repositories required resolving repoDir based on handoff.project_id to avoid routing into stale folders and inconsistent path selection.',
    },
    output: {
      kind: 'skip',
      reason:
        'internal handler names and internal handoff state (dispatch_land, handoff.project_id) have no public referent',
    },
  },
  {
    input: {
      title: 'Split behavior change',
      body_first_200:
        'A short note about changing a branching decision with no attached design rationale or external references.',
    },
    output: {
      kind: 'skip',
      reason: 'too vague — no specific concept to search',
    },
  },
  {
    input: {
      title: 'Concurrent boot flow assertions',
      body_first_200:
        'Capture boot ordering assertions around startup events and queue hydration while multiple services come up in parallel.',
    },
    output: {
      kind: 'query',
      query: 'concurrent boot flow assertions startup ordering nodejs',
    },
  },
  {
    input: {
      title: 'handoffWriter::createTempHandoffRow',
      body_first_200:
        'Internal helper name was used as a heading while debugging; no context described the underlying concept for outside readers.',
    },
    output: {
      kind: 'skip',
      reason: 'pure code identifier',
    },
  },
  {
    input: {
      title: 'SQLite WAL mode performance at high write throughput',
      body_first_200:
        'Observed checkpoint lag and fsync jitter after enabling WAL; tuning checkpoints and page size made the test and metrics profile repeatable.',
    },
    output: {
      kind: 'query',
      query: 'SQLite WAL mode performance high write throughput',
    },
  },
];
