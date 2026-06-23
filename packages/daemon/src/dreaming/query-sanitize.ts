const FORBIDDEN_URI_PREFIXES = ["http://", "https://", "file://", "ftp://", "javascript:", "data:"];

export function sanitizeTitleForQuery(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (FORBIDDEN_URI_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return null;
  }

  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) <= 0x1f) {
      return null;
    }
  }

  return trimmed;
}
