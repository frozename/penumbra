import type { WorkflowCtx } from "@penumbra/workflows";

import { join } from "node:path";

import type { FanoutHop } from "../_shared/fanout-hop-evidence.js";
import type { FanoutTaskResult } from "../_shared/fanout.js";

import { sanitizeFileStem } from "../_shared/io.js";

const CHECK_LINE_MAX = 300;
const TERMINAL_HOP_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);

export type BoundedResult = Omit<FanoutTaskResult, "response_text"> & {
  response_path: string | null;
  response_chars: number | null;
  check_line: string | null;
  latest_branch_name: string | null;
};

function firstNonemptyLine(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, maxLen);
  }
  return null;
}

export function resolveLatestBranch(
  hops: FanoutHop[] | null,
  latestHandoffId: string | null,
): string | null {
  if (!hops || !latestHandoffId) return null;
  const hop = hops.find((h) => h.handoff_id === latestHandoffId);
  if (!hop || !TERMINAL_HOP_STATUSES.has(hop.status)) return null;
  return hop.branch_name && hop.branch_name.length > 0 ? hop.branch_name : null;
}

function isValidWriteReceipt(receipt: unknown, artifactPath: string): receipt is string {
  return typeof receipt === "string" && receipt.trim().length > 0 && receipt === artifactPath;
}

export async function buildBoundedResult(
  result: FanoutTaskResult,
  outDirPath: string | null,
  ctx: WorkflowCtx,
): Promise<BoundedResult> {
  const { response_text: responseText, ...summary } = result;
  const base: BoundedResult = {
    ...summary,
    response_path: null,
    response_chars: null,
    check_line: firstNonemptyLine(responseText, CHECK_LINE_MAX),
    latest_branch_name: resolveLatestBranch(result.hops, result.latest_handoff_id),
  };

  if (!responseText || !outDirPath) return base;

  const artifactPath = join(
    outDirPath,
    `${sanitizeFileStem(result.label)}-${String(result.index)}.txt`,
  );
  try {
    const written = await ctx.fileWrite(artifactPath, responseText);
    if (!isValidWriteReceipt(written, artifactPath)) {
      throw new Error("invalid response artifact write receipt");
    }
    base.response_path = written;
    base.response_chars = responseText.length;
  } catch {
    base.ok = false;
    base.error_summary = base.error_summary
      ? `${base.error_summary}; response_artifact_write_failed`
      : "response_artifact_write_failed";
    base.response_path = null;
  }
  return base;
}
