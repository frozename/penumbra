export function fmtDur(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0 && hours === 1) {
    return `${hours}h`;
  }
  if (minutes === 0) {
    return `${hours}h 0m`;
  }
  return `${hours}h ${minutes}m`;
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
