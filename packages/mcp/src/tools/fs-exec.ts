import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeFsEnvelopeResult, type FsEnvelopeHandlerOpts } from "./fs-envelope.js";

export const FsExecInputShape = {
  command: z
    .string()
    .min(1)
    .describe("Shell command to run inside the worktree (cwd is the worktree root)."),
  handoff_id: z
    .string()
    .optional()
    .describe("Worktree to scope the command to. Defaults to PENUMBRA_HANDOFF_ID env var."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Timeout in milliseconds (default 120000, max 600000). On timeout, the process is killed and timed_out:true is returned.",
    ),
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

export function fsExecHandler(daemon: DaemonClient, opts?: FsEnvelopeHandlerOpts) {
  return async (input: any) => {
    const handoff_id = input.handoff_id || process.env.PENUMBRA_HANDOFF_ID;
    if (!handoff_id) {
      return errorContent(
        "no_handoff_context",
        "pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)",
      );
    }
    try {
      const result = await daemon.execInWorktree(handoff_id, {
        command: input.command,
        timeout_ms: input.timeout_ms,
      });
      const rawJson = JSON.stringify(result);
      if (input.envelope) {
        return makeFsEnvelopeResult(rawJson, opts);
      }
      return { content: [{ type: "text" as const, text: rawJson }] };
    } catch (err) {
      return toErrorContent(err);
    }
  };
}
