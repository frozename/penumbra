import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";
import type { HandleStore } from "../handle-store.js";
import { DEFAULT_BUDGET, truncateToTokens } from "../responses/budget.js";

const WORKFLOW_WAIT_INLINE_BYTE_LIMIT = DEFAULT_BUDGET * 4;
const WORKFLOW_WAIT_PREVIEW_CHAR_SLICE = DEFAULT_BUDGET * 10;

function boundField(
  out: Record<string, unknown>,
  payload: Record<string, unknown>,
  field: "result" | "error",
  handleStore?: HandleStore,
) {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
  const truncatedKey = `${field}_truncated`;
  const previewKey = `${field}_preview`;
  const bytesKey = `${field}_bytes`;
  const handleKey = `${field}_handle_id`;

  // Mixed deploy safety: if daemon already truncated, preserve daemon fields verbatim.
  if (payload[field] === null && payload[truncatedKey] === true) return;

  const value = payload[field];
  if (value === undefined) return;

  const serialized = JSON.stringify(value);
  if (serialized === undefined) return;

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
    return;
  }

  out[truncatedKey] = false;
  delete out[previewKey];
  delete out[handleKey];
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
    boundField(out, payload, "result", handleStore);
    boundField(out, payload, "error", handleStore);

    return toTextContent(out);
  };
}
