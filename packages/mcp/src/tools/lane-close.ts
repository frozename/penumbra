import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import { LaneCloseMetadataSchema, type LaneCloseMetadata } from "@penumbra/core";
import type { DaemonClient } from "../daemon-client.js";

export const LaneCloseInputShape = {
  lane_id: z.string().min(1),
  gate_status: z.enum(["passed", "failed", "skipped", "review_debt"]),
  reviewer_handoff_id: z.string().min(1).optional(),
  override_reason: z.string().min(1).optional(),
  metadata: LaneCloseMetadataSchema.optional(),
};

export function laneCloseHandler(daemon: DaemonClient) {
  return async (input: {
    lane_id: string;
    gate_status: "passed" | "failed" | "skipped" | "review_debt";
    reviewer_handoff_id?: string;
    override_reason?: string;
    metadata?: LaneCloseMetadata;
  }) => {
    const response = (await postToDaemon(daemon, "/lanes/close", {
      lane_id: input.lane_id,
      gate_status: input.gate_status,
      reviewer_handoff: input.reviewer_handoff_id,
      override_reason: input.override_reason,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    })) as {
      lane_id: string;
      gate_status: "passed" | "failed" | "skipped" | "review_debt";
      implementer_handoff?: string | null;
      reviewer_handoff?: string | null;
    };

    let memory_verify_authorization:
      | "authorized"
      | "skipped_no_reviewer"
      | "not_applicable"
      | "authorize_failed" = "not_applicable";
    if (response.gate_status !== "skipped" && response.gate_status !== "review_debt") {
      if (!response.implementer_handoff) {
        throw new Error("daemon /lanes/close: missing implementer_handoff in response");
      }
      // A close without a reviewer handoff (e.g. maestro-attested after a local
      // review) has nothing to authorize the memory-verify chain WITH — the
      // daemon's lane_close basis requires a reviewer — so the authorization
      // step is skipped instead of failing a close that already persisted. The
      // skip is surfaced in the result so reviewer-less closes stay observable.
      if (response.reviewer_handoff) {
        // The lane row is already persisted by /lanes/close above. If the
        // secondary memory-verify authorize call fails, surface the failure in
        // the result instead of throwing — otherwise a caller may retry an
        // already-committed close.
        try {
          await postToDaemon(daemon, "/memory-verify/authorize", {
            handoff_id: response.implementer_handoff,
            verdict: response.gate_status,
            basis: {
              kind: "lane_close",
              lane_id: response.lane_id,
              reviewer_handoff: response.reviewer_handoff,
            },
            authorized_by_handoff: response.reviewer_handoff,
          });
          memory_verify_authorization = "authorized";
        } catch {
          memory_verify_authorization = "authorize_failed";
        }
      } else {
        memory_verify_authorization = "skipped_no_reviewer";
      }
    }

    return toTextContent({ ...response, memory_verify_authorization });
  };
}

async function postToDaemon(daemon: DaemonClient, path: string, body: unknown): Promise<unknown> {
  const { baseUrl, token } = (
    daemon as unknown as { resolve: () => { baseUrl: string; token: string } }
  ).resolve();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await daemonHttpError(path, res);
  return await res.json();
}

async function daemonHttpError(path: string, res: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {}
  return new Error(
    `daemon ${path}: HTTP ${res.status}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`,
  );
}
