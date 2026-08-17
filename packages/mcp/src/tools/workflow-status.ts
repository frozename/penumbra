import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";
import type { HandleStore } from "../handle-store.js";

import {
  DEFAULT_BUDGET,
  estimateTokens,
  sliceSurrogateSafe,
  truncateToTokens,
} from "../responses/budget.js";
import { type EnvelopeResult, makeEnvelopeResult } from "../responses/envelope.js";

const WORKFLOW_WAIT_INLINE_BYTE_LIMIT = DEFAULT_BUDGET * 4;
const WORKFLOW_WAIT_PREVIEW_CHAR_SLICE = DEFAULT_BUDGET * 10;

interface BoundFieldKeys {
  truncated: string;
  preview: string;
  bytes: string;
  handle: string;
}

function fieldKeys(field: "result" | "error"): BoundFieldKeys {
  return {
    truncated: `${field}_truncated`,
    preview: `${field}_preview`,
    bytes: `${field}_bytes`,
    handle: `${field}_handle_id`,
  };
}

function rebuildWithout(
  source: Record<string, unknown>,
  drop: readonly string[],
): Record<string, unknown> {
  const dropSet = new Set(drop);
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!dropSet.has(k)) {
      next[k] = v;
    }
  }
  return next;
}

function spillField(
  out: Record<string, unknown>,
  payload: Record<string, unknown>,
  field: "result" | "error",
  serialized: string,
  keys: BoundFieldKeys,
  handleStore: HandleStore | undefined,
): Record<string, unknown> {
  out[field] = null;
  out[keys.truncated] = true;
  out[keys.preview] = truncateToTokens(
    serialized.slice(0, WORKFLOW_WAIT_PREVIEW_CHAR_SLICE),
    DEFAULT_BUDGET,
  ).text;
  if (handleStore) {
    out[keys.handle] = handleStore.put(serialized);
    return out;
  }
  return rebuildWithout(out, [keys.handle]);
}

function clearSpill(out: Record<string, unknown>, keys: BoundFieldKeys): Record<string, unknown> {
  out[keys.truncated] = false;
  return rebuildWithout(out, [keys.preview, keys.handle]);
}

interface BoundFieldOutcome {
  spilled: boolean;
  out: Record<string, unknown>;
}

function boundField(
  out: Record<string, unknown>,
  payload: Record<string, unknown>,
  field: "result" | "error",
  handleStore?: HandleStore,
): BoundFieldOutcome {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    return { spilled: false, out };
  }
  const keys = fieldKeys(field);

  // Mixed deploy safety: if daemon already truncated, preserve daemon fields verbatim.
  if (payload[field] === null && payload[keys.truncated] === true) {
    return { spilled: false, out };
  }

  const value = payload[field];
  if (value === undefined) {
    return { spilled: false, out };
  }

  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  out[keys.bytes] = typeof payload[keys.bytes] === "number" ? payload[keys.bytes] : bytes;
  if (bytes > WORKFLOW_WAIT_INLINE_BYTE_LIMIT) {
    return { spilled: true, out: spillField(out, payload, field, serialized, keys, handleStore) };
  }
  return { spilled: false, out: clearSpill(out, keys) };
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

export function workflowStatusHandler(
  daemon: DaemonClient,
): (input: { workflow_run_id: string }) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.workflowStatus(input));
}

function shrinkOneRound(out: Record<string, unknown>, previewKeys: string[]): boolean {
  let shrunk = false;
  for (const key of previewKeys) {
    const current = out[key];
    if (typeof current !== "string" || current.length === 0) {
      continue;
    }
    const next = sliceSurrogateSafe(current, Math.floor(current.length * 0.9));
    if (next.length < current.length) {
      out[key] = next;
      shrunk = true;
    }
  }
  return shrunk;
}

function shrinkPreviewsToFit(out: Record<string, unknown>, previewKeys: string[]): string {
  let text = JSON.stringify(out);
  while (estimateTokens(text) > DEFAULT_BUDGET) {
    if (!shrinkOneRound(out, previewKeys)) {
      break;
    }
    text = JSON.stringify(out);
  }
  return text;
}

export function workflowWaitHandler(
  daemon: DaemonClient,
  opts?: { handleStore?: HandleStore },
): (input: {
  workflow_run_id: string;
  timeout_ms?: number;
}) => Promise<TextContentEnvelope | EnvelopeResult> {
  return async (input): Promise<TextContentEnvelope | EnvelopeResult> => {
    const payload = (await daemon.workflowWait(input)) as Record<string, unknown>;
    let out: Record<string, unknown> = { ...payload };
    const handleStore = opts?.handleStore;
    const resultOutcome = boundField(out, payload, "result", handleStore);
    out = resultOutcome.out;
    const errorOutcome = boundField(out, payload, "error", handleStore);
    out = errorOutcome.out;
    const spilledResult = resultOutcome.spilled;
    const spilledError = errorOutcome.spilled;

    if (!spilledResult && !spilledError) {
      return toTextContent(out);
    }

    // Each spilled preview was independently truncated to DEFAULT_BUDGET, so a
    // dual-spill envelope can otherwise reach ~2x the budget. Re-shrink the
    // spilled previews jointly until the combined JSON fits.
    const spilledPreviewKeys: string[] = [];
    if (spilledResult) {
      spilledPreviewKeys.push("result_preview");
    }
    if (spilledError) {
      spilledPreviewKeys.push("error_preview");
    }
    const text = shrinkPreviewsToFit(out, spilledPreviewKeys);

    return makeEnvelopeResult([{ type: "text", text }], {
      usedTokens: estimateTokens(text),
      limitTokens: DEFAULT_BUDGET,
      truncated: spilledResult || spilledError,
      resultBytes: Buffer.byteLength(text, "utf8"),
    });
  };
}
