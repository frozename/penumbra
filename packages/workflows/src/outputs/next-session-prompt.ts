import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NextSessionPromptResult = { warnings: string[]; path?: string };

export async function emitNextSessionPromptOutput(input: {
  body: string;
  storageRoot: string;
}): Promise<NextSessionPromptResult> {
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
    await writeFile(target, input.body, "utf8");
    return { warnings: [], path: target };
  } catch (err: any) {
    return { warnings: [`output next-session-prompt: ${err?.message ?? String(err)}`] };
  }
}
