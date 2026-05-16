import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { chainStartHandler, ChainStartInputShape, PromptProjectMismatchError, isEnvTruthy, type ChainStartHandlerOpts } from './chain-start.js';

export function chainStartRefinedHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  const inner = chainStartHandler(daemon, opts);
  const inputSchema = z.object(ChainStartInputShape);
  return async (rawInput: unknown) => {
    // Preflight: validate input shape BEFORE incurring refiner LLM cost. A
    // malformed input (missing initial_agent / task_class, invalid enum, etc.)
    // would fail at chain_start anyway; we surface it here without paying.
    const parsed = inputSchema.parse(rawInput);
    const originalGuard =
      parsed.project_id != null && opts.inspectPromptVsProject
        ? opts.inspectPromptVsProject({ prompt: parsed.message, project_id: parsed.project_id })
        : undefined;
    if (originalGuard?.status === 'mismatch' && isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH)) {
      throw new PromptProjectMismatchError({
        projectId: parsed.project_id ?? '',
        mentionedPaths: originalGuard.mentioned_paths,
        missingInProject: originalGuard.missing_in_project,
        suggestedProjectId: originalGuard.suggested_project_id,
      });
    }
    const { refined } = await daemon.dispatchRefine(parsed.message);
    const response = await inner({ ...parsed, message: refined });
    if (originalGuard?.status === 'mismatch' && response.routing_warning === undefined) {
      return {
        ...response,
        routing_warning: {
          code: 'prompt_project_mismatch',
          project_id: parsed.project_id,
          mentioned_paths: originalGuard.mentioned_paths,
          missing_in_project: originalGuard.missing_in_project,
          suggested_project_id: originalGuard.suggested_project_id,
          hint: 'pass --project_id explicitly or update prompt paths',
        },
      };
    }
    if (originalGuard?.status === 'mismatch' && response.routing_warning !== undefined) {
      return {
        ...response,
        routing_warning: {
          ...response.routing_warning,
          mentioned_paths: [...new Set([
            ...originalGuard.mentioned_paths,
            ...response.routing_warning.mentioned_paths,
          ])],
          missing_in_project: [...new Set([
            ...originalGuard.missing_in_project,
            ...response.routing_warning.missing_in_project,
          ])],
          suggested_project_id: response.routing_warning.suggested_project_id ?? originalGuard.suggested_project_id,
        },
      };
    }
    if ((originalGuard as { status?: string } | undefined)?.status === 'registry_unavailable' && response.routing_advisory === undefined) {
      return {
        ...response,
        routing_advisory: { code: 'project_registry_unavailable' },
      };
    }
    return response;
  };
}
