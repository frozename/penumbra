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

export const FsEditInputShape = {
  path: z.string().min(1).describe("File path inside the worktree to edit."),
  old_string: z.string().describe("The exact string to search for and replace."),
  new_string: z.string().describe("The replacement string (may be empty to delete old_string)."),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "When true, replace every occurrence of old_string. Default false (requires old_string to appear exactly once).",
    ),
  handoff_id: z
    .string()
    .optional()
    .describe("Worktree to scope the edit to. Defaults to PENUMBRA_HANDOFF_ID env var."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

interface FsEditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  handoff_id?: string;
  envelope?: boolean;
}

export function fsEditHandler(
  daemon: DaemonClient,
  opts?: FsEnvelopeHandlerOpts,
): (input: FsEditInput) => Promise<FsToolResult> {
  return async (input): Promise<FsToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return errorContent(resolved.error.code, resolved.error.message);
    }
    const handoff_id = resolved.handoff_id;
    try {
      const result = await daemon.editInWorktree(handoff_id, {
        path: input.path,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all,
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
