import { TaskClassSchema, type TaskClass } from '@penumbra/core';

export interface AutoRecallDeps {
  memoryRecall: (args: { query: string; top_k: number; project_id?: string }) => Promise<{
    hits: Array<{
      id: string;
      title: string;
      snippet?: string;
      obs_type?: string;
      tier?: string;
    }>;
  }>;
  logger?: (level: 'debug' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

export interface AutoRecallInput {
  prompt: string;
  task_class: TaskClass;
  project_id?: string;
}

export interface AutoRecallResult {
  recalled_memory_ids: string[];
  recalled_memories: Array<{
    id: string;
    title: string;
    obs_type: string;
    snippet_head?: string;
  }>;
  recalled_query: string;
  injected_text: string | null;
}

const TOP_K_BY_TASK_CLASS: Record<TaskClass, number> = {
  STANDARD: 5,
  BOUNDARY: 8,
  TRIVIAL: 3,
};

export async function autoRecallForDispatch(input: AutoRecallInput, deps: AutoRecallDeps): Promise<AutoRecallResult> {
  const taskClass = TaskClassSchema.parse(input.task_class);
  const recalled_query = `${input.prompt.slice(0, 600)} task_class:${taskClass}`;
  const top_k = TOP_K_BY_TASK_CLASS[taskClass];

  try {
    const recallArgs: { query: string; top_k: number; project_id?: string } = { query: recalled_query, top_k };
    if (input.project_id !== undefined) recallArgs.project_id = input.project_id;
    let result = await deps.memoryRecall(recallArgs);
    if (Array.isArray(result.hits) && result.hits.length === 0 && input.project_id !== undefined) {
      const fallbackArgs: { query: string; top_k: number } = { query: recalled_query, top_k };
      const fallback = await deps.memoryRecall(fallbackArgs);
      if (fallback && Array.isArray(fallback.hits) && fallback.hits.length > 0) {
        result = fallback;
        deps.logger?.('debug', 'auto-recall used cross-project fallback', { task_class: taskClass });
      }
    }
    if (!result || !Array.isArray(result.hits)) {
      throw new Error('memoryRecall returned invalid hits');
    }

    const recalled_memory_ids = result.hits.map((hit) => hit.id);
    const recalled_memories = result.hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      obs_type: hit.obs_type ?? hit.tier ?? 'memory',
      snippet_head: hit.snippet,
    }));
    if (result.hits.length === 0) {
      return {
        recalled_memory_ids,
        recalled_memories,
        recalled_query,
        injected_text: null,
      };
    }

    return {
      recalled_memory_ids,
      recalled_memories,
      recalled_query,
      injected_text: renderInjectedText(result.hits),
    };
  } catch (err) {
    deps.logger?.('warn', 'auto-recall failed', {
      error: String(err),
      task_class: taskClass,
    });
    return {
      recalled_memory_ids: [],
      recalled_memories: [],
      recalled_query,
      injected_text: null,
    };
  }
}

function renderInjectedText(hits: Array<{ id: string; title: string; snippet?: string }>): string {
  const lines = hits.map((hit) => {
    const detail = truncateSnippet(hit.snippet ?? hit.title, 120);
    return `- ${hit.title} - ${detail}`;
  });

  return [
    '## Relevant prior context',
    '',
    'The following memories were auto-recalled at dispatch time. Treat them as',
    'prior knowledge, not as authoritative ground truth - verify against the',
    'current codebase before acting:',
    '',
    ...lines,
  ].join('\n');
}

function truncateSnippet(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}
