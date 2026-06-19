import type { HandleStore } from "../handle-store.js";
import {
  DEFAULT_BUDGET,
  estimateTokens,
  sliceSurrogateSafe,
  truncateToTokens,
} from "../responses/budget.js";
import { makeEnvelopeResult } from "../responses/envelope.js";

export interface FsEnvelopeHandlerOpts {
  handleStore?: HandleStore;
}

function makePreviewText(rawJson: string): string {
  if (estimateTokens(rawJson) <= DEFAULT_BUDGET) return rawJson;

  let preview = truncateToTokens(rawJson, Math.max(1, DEFAULT_BUDGET - 64)).text;
  let text = JSON.stringify({ truncated: true, preview });
  while (estimateTokens(text) > DEFAULT_BUDGET && preview.length > 0) {
    preview = sliceSurrogateSafe(preview, Math.floor(preview.length * 0.9));
    text = JSON.stringify({ truncated: true, preview });
  }
  return text;
}

export function makeFsEnvelopeResult(rawJson: string, opts?: FsEnvelopeHandlerOpts) {
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
