import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NextSessionPromptResult = { warnings: string[]; path?: string; skipped?: boolean };

export const PRESERVE_NEXT_SESSION_PROMPT = "<!-- penumbra:preserve-next-session-prompt -->";

function sectionHead(name: string): string {
  return `<!-- penumbra:section ${name} -->`;
}
function sectionTail(name: string): string {
  return `<!-- /penumbra:section ${name} -->`;
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertSection(existing: string, workflowName: string, body: string): string {
  const head = sectionHead(workflowName);
  const tail = sectionTail(workflowName);
  const section = `${head}\n${body}\n${tail}\n`;
  const re = new RegExp(`${escapeRegex(head)}[\\s\\S]*?${escapeRegex(tail)}\\n?`);
  if (re.test(existing)) {
    return existing.replace(re, section);
  }
  if (existing.length === 0) return section;
  return existing.endsWith("\n") ? existing + section : `${existing}\n${section}`;
}

export async function emitNextSessionPromptOutput(input: {
  body: string;
  storageRoot: string;
  workflowName: string;
}): Promise<NextSessionPromptResult> {
  if (input.body.trim() === PRESERVE_NEXT_SESSION_PROMPT) {
    return { warnings: [], skipped: true };
  }

  if (input.body.trim() === "") {
    return {
      warnings: [
        "output next-session-prompt: empty body — skipped write to preserve existing artifact",
      ],
    };
  }

  const target = join(input.storageRoot, "pending-handoff.md");
  try {
    await mkdir(input.storageRoot, { recursive: true });
    let existing = "";
    try {
      existing = await readFile(target, "utf8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") throw err;
    }
    const merged = upsertSection(existing, input.workflowName, input.body);
    await writeFile(target, merged, "utf8");
    return { warnings: [], path: target };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { warnings: [`output next-session-prompt: ${msg}`] };
  }
}
