import { createHash } from "node:crypto";
import { join } from "node:path";

export type PendingHandoffSection = { writtenAt: Date | null; body: string };

const FILENAME_SAFE_PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const WRITTEN_STAMP = /^<!-- penumbra:written (\S+) -->\n?/;
const SECTION = /<!-- penumbra:section (\S+) -->\n([\s\S]*?)\n?<!-- \/penumbra:section \1 -->/g;

// Synthetic project ids (`<remote-hash>:<relpath>`) carry path separators, and
// a case-insensitive filesystem could fold two ids together: anything outside
// the registry's lowercase slug alphabet is hashed instead.
export function pendingHandoffPath(storageRoot: string, project: string): string {
  const key = FILENAME_SAFE_PROJECT.test(project)
    ? project
    : createHash("sha256").update(project).digest("hex").slice(0, 16);
  return join(storageRoot, `pending-handoff.${key}.md`);
}

function sectionHead(name: string): string {
  return `<!-- penumbra:section ${name} -->`;
}
function sectionTail(name: string): string {
  return `<!-- /penumbra:section ${name} -->`;
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertPendingHandoffSection(
  existing: string,
  input: { name: string; body: string; writtenAt: Date },
): { text: string; replaced: boolean } {
  const head = sectionHead(input.name);
  const tail = sectionTail(input.name);
  const stamp = `<!-- penumbra:written ${input.writtenAt.toISOString()} -->`;
  const section = `${head}\n${stamp}\n${input.body}\n${tail}\n`;
  const re = new RegExp(`${escapeRegex(head)}[\\s\\S]*?${escapeRegex(tail)}\\n?`);
  if (re.test(existing)) {
    return { text: existing.replace(re, () => section), replaced: true };
  }
  if (existing.length === 0) return { text: section, replaced: false };
  const sep = existing.endsWith("\n") ? "" : "\n";
  return { text: `${existing}${sep}${section}`, replaced: false };
}

export function parsePendingHandoffSections(text: string): PendingHandoffSection[] {
  const sections: PendingHandoffSection[] = [];
  for (const match of text.matchAll(SECTION)) {
    const content = match[2] ?? "";
    const stamp = WRITTEN_STAMP.exec(content);
    const writtenMs = stamp ? Date.parse(stamp[1] ?? "") : Number.NaN;
    sections.push({
      writtenAt: Number.isNaN(writtenMs) ? null : new Date(writtenMs),
      body: (stamp ? content.slice(stamp[0].length) : content).trim(),
    });
  }
  return sections;
}
