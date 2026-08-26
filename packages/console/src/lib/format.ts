export function fmtDur(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours === 0) {
    return `${String(minutes)}m`;
  }
  if (minutes === 0 && hours === 1) {
    return `${String(hours)}h`;
  }
  if (minutes === 0) {
    return `${String(hours)}h 0m`;
  }
  return `${String(hours)}h ${String(minutes)}m`;
}

export function providerLabel(slug: string): string {
  return (
    (
      {
        anthropic: "Anthropic",
        openai: "OpenAI",
        google: "Google",
        "opencode-go": "OpenCode",
      } as Record<string, string>
    )[slug] ?? slug
  );
}

/** Formats an epoch-ms timestamp as a compact UTC "YYYY-MM-DD HH:mm" string. */
export function fmtTs(epochMs: number): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(epochMs) || Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function summarizeWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) {
    return text.trim();
  }
  return `${words.slice(0, n).join(" ")}…`;
}
