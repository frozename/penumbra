import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

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

function errorContent(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

function toErrorContent(err: any) {
  const code = err?.body?.error?.code ?? (err?.status === 404 ? "not_found" : "internal_error");
  const message = err?.body?.error?.message ?? err?.message ?? "unknown error";
  return errorContent(code, message);
}

export function fsGlobHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const handoff_id = input.handoff_id || process.env.PENUMBRA_HANDOFF_ID;
    if (!handoff_id) {
      return errorContent(
        "no_handoff_context",
        "pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)",
      );
    }
    try {
      const result = await daemon.globInWorktree(handoff_id, {
        pattern: input.pattern,
        path: input.path ?? null,
        max_results: input.max_results ?? null,
        include_ignored: input.include_ignored === true,
      });
      const rawJson = JSON.stringify(result);
      if (input.envelope) {
        const resultBytes = Buffer.byteLength(rawJson, "utf8");
        const { text, truncated } = truncateToTokens(rawJson, DEFAULT_BUDGET);
        return makeEnvelopeResult([{ type: "text", text }], {
          usedTokens: estimateTokens(text),
          limitTokens: DEFAULT_BUDGET,
          truncated,
          resultBytes,
        });
      }
      return { content: [{ type: "text" as const, text: rawJson }] };
    } catch (err) {
      return toErrorContent(err);
    }
  };
}
