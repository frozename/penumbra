import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Registry } from "./registry.js";

const SLASH_COMMAND_TEMPLATE = (name: string, description: string): string => `---
description: ${description}
---

Run penumbra workflow \`${name}\` via the workflow runtime.

This slash command invokes:

\`\`\`
mcp__penumbra__workflow_run({ "name": "${name}" })
\`\`\`

The workflow auto-recalls memory, optionally dispatches agents with tailored bundles, and emits the configured output sinks.
`;

const SKILL_SLASH_COMMAND_TEMPLATE = (skill: string, description: string): string => `---
description: ${description}
---

Invoke the \`${skill}\` skill via \`Skill(${skill})\` and follow its full protocol, every step in order.
`;

export function writeSlashCommands(reg: Registry, commandsDir: string): string[] {
  mkdirSync(commandsDir, { recursive: true });
  const written: string[] = [];
  const skillCommands = new Set<string>();
  for (const spec of reg.list()) {
    for (const t of spec.triggers) {
      if (t.kind !== "slash") continue;
      const path = join(commandsDir, `${t.command}.md`);
      if (t.skill !== undefined) {
        writeFileSync(path, SKILL_SLASH_COMMAND_TEMPLATE(t.skill, spec.description), "utf8");
        skillCommands.add(t.command);
        written.push(path);
        break;
      }
      if (skillCommands.has(t.command)) break;
      writeFileSync(path, SLASH_COMMAND_TEMPLATE(spec.name, spec.description), "utf8");
      written.push(path);
      break;
    }
  }
  return written;
}
