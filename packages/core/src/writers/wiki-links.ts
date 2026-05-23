export function parseWikiLinks(body: string): string[] {
  const links = body.matchAll(/\[\[([a-z0-9-]+)\]\]/g);
  const found = new Set<string>();
  for (const match of links) {
    const slug = match[1];
    if (slug) found.add(slug);
  }
  return Array.from(found);
}
