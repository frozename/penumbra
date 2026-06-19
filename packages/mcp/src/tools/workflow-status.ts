import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";
import type { HandleStore } from "../handle-store.js";
import { DEFAULT_BUDGET, estimateTokens, truncateToTokens } from "../responses/budget.js";
import { makeEnvelopeResult } from "../responses/envelope.js";

const WORKFLOW_WAIT_INLINE_BYTE_LIMIT = DEFAULT_BUDGET * 4;
const WORKFLOW_WAIT_PREVIEW_CHAR_SLICE = DEFAULT_BUDGET * 10;

function boundField(
  out: Record<string, unknown>,
  payload: Record<string, unknown>,
  field: "result" | "error",
  handleStore?: HandleStore,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return false;
  const truncatedKey = `${field}_truncated`;
  const previewKey = `${field}_preview`;
  const bytesKey = `${field}_bytes`;
  const handleKey = `${field}_handle_id`;

  // Mixed deploy safety: if daemon already truncated, preserve daemon fields verbatim.
  if (payload[field] === null && payload[truncatedKey] === true) return false;

  const value = payload[field];
  if (value === undefined) return false;

  const serialized = JSON.stringify(value);
  if (serialized === undefined) return false;

  const bytes = Buffer.byteLength(serialized, "utf8");
  out[bytesKey] = typeof payload[bytesKey] === "number" ? payload[bytesKey] : bytes;
  if (bytes > WORKFLOW_WAIT_INLINE_BYTE_LIMIT) {
    out[field] = null;
    out[truncatedKey] = true;
    out[previewKey] = truncateToTokens(
      serialized.slice(0, WORKFLOW_WAIT_PREVIEW_CHAR_SLICE),
      DEFAULT_BUDGET,
    ).text;
    if (handleStore) {
      out[handleKey] = handleStore.put(serialized);
    } else {
      delete out[handleKey];
    }
    return true;
  }

  out[truncatedKey] = false;
  delete out[previewKey];
  delete out[handleKey];
  return false;
}

export const WorkflowStatusInputShape = {
  workflow_run_id: z.string().min(1).describe("Workflow run id returned by workflow_run."),
};

export const WorkflowWaitInputShape = {
  workflow_run_id: z.string().min(1).describe("Workflow run id returned by workflow_run."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(1_800_000)
    .optional()
    .default(300000)
    .describe("Timeout in ms (default 300000, max 1800000)."),
};

export function workflowStatusHandler(daemon: DaemonClient) {
  return async (input: { workflow_run_id: string }) =>
    toTextContent(await daemon.workflowStatus(input));
}

export function workflowWaitHandler(daemon: DaemonClient, opts?: { handleStore?: HandleStore }) {
  return async (input: { workflow_run_id: string; timeout_ms?: number }) => {
    const payload = (await daemon.workflowWait(input)) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...payload };
    const handleStore = opts?.handleStore;
    const spilledResult = boundField(out, payload, "result", handleStore);
    const spilledError = boundField(out, payload, "error", handleStore);

    if (spilledResult || spilledError) {
      const text = JSON.stringify(out);
      return makeEnvelopeResult([{ type: "text", text }], {
        usedTokens: estimateTokens(text),
        limitTokens: DEFAULT_BUDGET,
        truncated: false,
        resultBytes: Buffer.byteLength(text, "utf8"),
      });
    }
    return toTextContent(out);
  };
}
