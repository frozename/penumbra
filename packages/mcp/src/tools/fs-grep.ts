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

export const FsGrepInputShape = {
  pattern: z.string().min(1).describe("Regular expression to search for."),
  path: z
    .string()
    .optional()
    .describe("Optional sub-path inside the worktree to search; defaults to worktree root."),
  glob: z.string().optional().describe('Optional file pattern filter (e.g. "*.ts").'),
  output_mode: z
    .enum(["content", "files_with_matches"])
    .optional()
    .describe('Default "content" returns matching lines; "files_with_matches" returns just paths.'),
  case_insensitive: z.boolean().optional().describe("Case-insensitive match. Default false."),
  include_ignored: z
    .boolean()
    .optional()
    .describe("Search files normally excluded by .gitignore. Default false."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe(
      "Soft cap. Default: content=50 (ceiling 500), files_with_matches=1000 (ceiling 5000).",
    ),
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

interface FsGrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches";
  case_insensitive?: boolean;
  include_ignored?: boolean;
  max_results?: number;
  handoff_id?: string;
  envelope?: boolean;
}

export function fsGrepHandler(
  daemon: Pick<DaemonClient, "grepInWorktree">,
  opts?: FsEnvelopeHandlerOpts,
): (input: FsGrepInput) => Promise<FsToolResult> {
  return async (input): Promise<FsToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return errorContent(resolved.error.code, resolved.error.message);
    }
    const handoff_id = resolved.handoff_id;

    const outputMode = input.output_mode ?? "content";
    if (
      outputMode === "content" &&
      typeof input.max_results === "number" &&
      input.max_results > 500
    ) {
      return errorContent("invalid_args", "max_results must be <= 500 for content mode");
    }

    try {
      const result = await daemon.grepInWorktree(handoff_id, {
        pattern: input.pattern,
        path: input.path ?? null,
        glob: input.glob ?? null,
        output_mode: outputMode,
        case_insensitive: input.case_insensitive === true,
        include_ignored: input.include_ignored === true,
        max_results: input.max_results ?? null,
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
