import { mkdir, readFile, writeFile } from "node:fs/promises";

import { pendingHandoffPath, upsertPendingHandoffSection } from "../pending-handoff-file.js";

export type NextSessionPromptMode = "created" | "section_appended" | "section_replaced";

export type NextSessionPromptResult = {
  warnings: string[];
  path?: string;
  mode?: NextSessionPromptMode;
  skipped?: boolean;
};

export const PRESERVE_NEXT_SESSION_PROMPT = "<!-- penumbra:preserve-next-session-prompt -->";

function writeMode(existed: boolean, replaced: boolean): NextSessionPromptMode {
  if (!existed) return "created";
  return replaced ? "section_replaced" : "section_appended";
}

export async function emitNextSessionPromptOutput(input: {
  body: string;
  storageRoot: string;
  workflowName: string;
  project: string;
  now?: () => Date;
}): Promise<NextSessionPromptResult> {
  if (input.body.trim() === PRESERVE_NEXT_SESSION_PROMPT) {
    return { warnings: [], skipped: true };
  }

  if (input.body.trim() === "") {
    return {
      warnings: [
        "output next-session-prompt: empty body — skipped write to preserve existing artifact",
      ],
      skipped: true,
    };
  }

  const target = pendingHandoffPath(input.storageRoot, input.project);
  try {
    await mkdir(input.storageRoot, { recursive: true });
    let existing: string | null = null;
    try {
      existing = await readFile(target, "utf8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") throw err;
    }
    const merged = upsertPendingHandoffSection(existing ?? "", {
      name: input.workflowName,
      body: input.body,
      writtenAt: (input.now ?? ((): Date => new Date()))(),
    });
    await writeFile(target, merged.text, "utf8");
    return { warnings: [], path: target, mode: writeMode(existing !== null, merged.replaced) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { warnings: [`output next-session-prompt: ${msg}`] };
  }
}
