import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.js";

const SLASH_COMMAND_TEMPLATE = (name: string, description: string) => `---
description: ${description}
---

Run penumbra workflow \`${name}\` via the workflow runtime.

This slash command invokes:

\`\`\`
mcp__penumbra__workflow_run({ "name": "${name}" })
\`\`\`

The workflow auto-recalls memory, optionally dispatches agents with tailored bundles, and emits the configured output sinks.
`;

export function writeSlashCommands(reg: Registry, commandsDir: string): string[] {
  mkdirSync(commandsDir, { recursive: true });
  const written: string[] = [];
  for (const spec of reg.list()) {
    for (const t of spec.triggers) {
      if (t.kind !== "slash") continue;
      const path = join(commandsDir, `${t.command}.md`);
      writeFileSync(path, SLASH_COMMAND_TEMPLATE(spec.name, spec.description), "utf8");
      written.push(path);
      break;
    }
  }
  return written;
}
