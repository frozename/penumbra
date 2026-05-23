const WIKI_LINK_RE = /\[\[([a-z0-9-]+)\]\]/gi;

export function parseWikiLinks(body: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_RE.exec(body)) !== null) {
    const slug = match[1];
    if (slug) found.add(slug);
  }
  return Array.from(found);
}
