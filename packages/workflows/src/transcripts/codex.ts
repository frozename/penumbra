import type { ReadCodexTranscriptOptions, TranscriptReadResult } from "./types.js";

const UNQUALIFIED_FORMAT_REASON =
  "Codex transcript format is not qualified by a complete disposable capture";

export function readCodexTranscript(
  _options: ReadCodexTranscriptOptions,
): Promise<TranscriptReadResult> {
  return Promise.resolve({
    status: "unsupported",
    reason: UNQUALIFIED_FORMAT_REASON,
  });
}
