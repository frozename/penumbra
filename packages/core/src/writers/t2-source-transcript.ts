import { stripPrivacyTags } from "../redaction/privacy-tags.js";

function readBlocks(blocks: unknown[], depth: number): string | null {
  const parts = blocks
    .map((part) => readMessageText(part, depth + 1))
    .filter((part) => part !== null);
  return parts.length ? parts.join("\n\n") : null;
}

function readMessageText(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (Array.isArray(value)) return readBlocks(value, depth);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.type === "string" &&
    !["text", "input_text", "output_text", "message"].includes(record.type)
  )
    return null;
  for (const key of [
    "text",
    "message",
    "prompt",
    "response",
    "input",
    "content",
    "message_excerpt",
  ]) {
    const text = readMessageText(record[key], depth + 1);
    if (text !== null) return text;
  }
  return null;
}

function clean(text: string): string {
  return stripPrivacyTags(text)
    .replaceAll(/<\/?(?:function_calls|invoke|tool_call|tool_use|antml:[a-z_]+)\b[^>]*>/gi, " ")
    .replaceAll("\r\n", "\n")
    .trim();
}

export function readSourceTranscriptContent(
  payloadJson: string | null,
  summary: string | null,
): string {
  if (payloadJson) {
    try {
      const text = readMessageText(JSON.parse(payloadJson) as unknown);
      if (text !== null) return clean(text);
    } catch {
      // A malformed legacy payload can still have a usable stored summary.
    }
  }
  return clean(summary ?? "");
}
