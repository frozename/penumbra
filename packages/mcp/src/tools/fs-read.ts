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

export const FsReadInputShape = {
  path: z.string().min(1).describe("File path inside the worktree to read."),
  handoff_id: z
    .string()
    .optional()
    .describe("Worktree to scope the read to. Defaults to PENUMBRA_HANDOFF_ID env var."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

interface FsReadInput {
  path: string;
  handoff_id?: string;
  envelope?: boolean;
}

export function fsReadHandler(
  daemon: Pick<DaemonClient, "readInWorktree">,
  opts?: FsEnvelopeHandlerOpts,
): (input: FsReadInput) => Promise<FsToolResult> {
  return async (input): Promise<FsToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return errorContent(resolved.error.code, resolved.error.message);
    }
    const handoff_id = resolved.handoff_id;
    try {
      const result = await daemon.readInWorktree(handoff_id, { path: input.path });
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
