import type { AgentChatConfig } from "../config/types.js";

import { parseMentions } from "../mention/parser.js";
import { resolveMention } from "../mention/resolver.js";

export interface ResolveInitialAgentOpts {
  /** Explicit agent name override. When set, bypasses mention parsing entirely.
   *  Use this when the user message contains attached file content that may
   *  carry stray @-mentions the parser would otherwise pick up. */
  explicit?: string;
}

export function resolveInitialAgent(
  userMessage: string,
  config: AgentChatConfig,
  opts: ResolveInitialAgentOpts = {},
): string {
  if (opts.explicit) {
    const found = config.agents.find((a) => a.name === opts.explicit);
    if (!found) {
      const known = config.agents.map((a) => a.name).join(", ");
      throw new Error(
        `--initial-agent '${opts.explicit}' is not a configured agent. Known: ${known}`,
      );
    }
    return opts.explicit;
  }
  const defaultRoles = config.default_roles ?? {};
  const knownTargets = [...config.agents.map((a) => a.name), ...Object.keys(defaultRoles)];
  const mentions = parseMentions(userMessage, { knownTargets });
  const first = mentions[0];
  if (first) {
    const r = resolveMention(first.target, config);
    if (r.kind === "role" || r.kind === "name") return r.agent_name;
  }
  return defaultRoles.planner ?? "";
}
