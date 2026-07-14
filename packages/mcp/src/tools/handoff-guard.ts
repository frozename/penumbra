export type HandoffResolution =
  | { ok: true; handoff_id: string }
  | { ok: false; error: { code: string; message: string } };

export interface HandoffErrorContent {
  content: { type: "text"; text: string }[];
  isError: true;
}

/**
 * Uniform policy for resolving a handoff_id in MCP tools that act on a
 * worktree or dispatch-scoped shell session.
 *
 * When PENUMBRA_HANDOFF_ID is set (server running inside a dispatch), an
 * explicit input.handoff_id that differs from it is REJECTED with
 * `cross_handoff_denied` — a dispatched agent must not be able to read,
 * write, or tear down another dispatch's worktree by supplying a different
 * handoff_id at the tool boundary.
 *
 * When PENUMBRA_HANDOFF_ID is unset (maestro/operator context), the caller
 * may supply any handoff_id explicitly and it is used verbatim.
 */
export function resolveHandoffId(inputHandoffId?: string | null): HandoffResolution {
  const envHandoffId = process.env.PENUMBRA_HANDOFF_ID;
  if (envHandoffId && inputHandoffId && inputHandoffId !== envHandoffId) {
    return {
      ok: false,
      error: {
        code: "cross_handoff_denied",
        message:
          "explicit handoff_id does not match the ambient PENUMBRA_HANDOFF_ID; cross-dispatch access is denied",
      },
    };
  }
  const resolved = envHandoffId ?? inputHandoffId ?? undefined;
  if (!resolved) {
    return {
      ok: false,
      error: {
        code: "no_handoff_context",
        message:
          "pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)",
      },
    };
  }
  return { ok: true, handoff_id: resolved };
}

export function handoffErrorContent(code: string, message: string): HandoffErrorContent {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}
