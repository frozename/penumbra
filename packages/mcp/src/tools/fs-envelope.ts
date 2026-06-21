import type { HandleStore } from "../handle-store.js";

import { DaemonHttpError } from "../daemon-client.js";
import {
  DEFAULT_BUDGET,
  estimateTokens,
  sliceSurrogateSafe,
  truncateToTokens,
} from "../responses/budget.js";
import { type EnvelopeResult, makeEnvelopeResult } from "../responses/envelope.js";

export interface FsEnvelopeHandlerOpts {
  handleStore?: HandleStore;
}

export interface FsErrorContent {
  content: { type: "text"; text: string }[];
  isError: true;
}

export interface FsContentResult {
  content: { type: "text"; text: string }[];
}

export type FsToolResult = FsContentResult | FsErrorContent | EnvelopeResult;

function makePreviewText(rawJson: string): string {
  if (estimateTokens(rawJson) <= DEFAULT_BUDGET) {
    return rawJson;
  }

  let preview = truncateToTokens(rawJson, Math.max(1, DEFAULT_BUDGET - 64)).text;
  let text = JSON.stringify({ truncated: true, preview });
  while (estimateTokens(text) > DEFAULT_BUDGET && preview.length > 0) {
    preview = sliceSurrogateSafe(preview, Math.floor(preview.length * 0.9));
    text = JSON.stringify({ truncated: true, preview });
  }
  return text;
}

export function makeFsEnvelopeResult(
  rawJson: string,
  opts?: FsEnvelopeHandlerOpts,
): EnvelopeResult {
  const resultBytes = Buffer.byteLength(rawJson, "utf8");
  const truncated = estimateTokens(rawJson) > DEFAULT_BUDGET;
  const text = makePreviewText(rawJson);
  const handleId = truncated ? opts?.handleStore?.put(rawJson) : undefined;
  return makeEnvelopeResult([{ type: "text", text }], {
    usedTokens: estimateTokens(text),
    limitTokens: DEFAULT_BUDGET,
    truncated,
    resultBytes,
    handleId,
  });
}

export function errorContent(code: string, message: string): FsErrorContent {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

function extractDaemonError(err: DaemonHttpError): { code: string; message: string } {
  const body =
    typeof err.body === "object" && err.body !== null ? (err.body as Record<string, unknown>) : {};
  const error =
    typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>)
      : {};
  const defaultCode = err.status === 404 ? "not_found" : "internal_error";
  const code = typeof error.code === "string" ? error.code : defaultCode;
  const message = typeof error.message === "string" ? error.message : err.message;
  return { code, message };
}

export function toErrorContent(err: unknown): FsErrorContent {
  if (err instanceof DaemonHttpError) {
    const { code, message } = extractDaemonError(err);
    return errorContent(code, message);
  }
  const message = err instanceof Error ? err.message : "unknown error";
  return errorContent("internal_error", message);
}
