import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import {
  errorContent,
  type FsEnvelopeHandlerOpts,
  type FsToolResult,
  makeFsEnvelopeResult,
  toErrorContent,
} from "./fs-envelope.js";
import { resolveHandoffId } from "./handoff-guard.js";

export const FsGlobInputShape = {
  pattern: z.string().min(1).describe('Glob pattern (e.g. "**/*.ts").'),
  path: z
    .string()
    .optional()
    .describe("Optional sub-path inside the worktree to search; defaults to worktree root."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe("Soft cap; default 1000, hard ceiling 5000."),
  include_ignored: z.boolean().optional().describe("When true, ignore .gitignore. Default false."),
  handoff_id: z
    .string()
    .optional()
    .describe("Worktree to scope the search to. Defaults to PENUMBRA_HANDOFF_ID env var."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

interface FsGlobInput {
  pattern: string;
  path?: string;
  max_results?: number;
  include_ignored?: boolean;
  handoff_id?: string;
  envelope?: boolean;
}

export function fsGlobHandler(
  daemon: Pick<DaemonClient, "globInWorktree">,
  opts?: FsEnvelopeHandlerOpts,
): (input: FsGlobInput) => Promise<FsToolResult> {
  return async (input): Promise<FsToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return errorContent(resolved.error.code, resolved.error.message);
    }
    const handoff_id = resolved.handoff_id;
    try {
      const result = await daemon.globInWorktree(handoff_id, {
        pattern: input.pattern,
        path: input.path ?? null,
        max_results: input.max_results ?? null,
        include_ignored: input.include_ignored === true,
      });
      const rawJson = JSON.stringify(result);
      if (input.envelope) {
        return makeFsEnvelopeResult(rawJson, opts);
      }
      return { content: [{ type: "text", text: rawJson }] };
    } catch (err) {
      return toErrorContent(err);
    }
  };
}
