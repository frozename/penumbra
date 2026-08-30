import { type ValuePatternRule, WALKER_DEPTH_EXCEEDED_RULE_ID } from "@penumbra/core";

/**
 * Rules sourced from `tools/maestro-bench/bench-maestro.py` v2 evidence
 * (llamactl repo). Each pattern targets a copy-pasteable artifact that
 * appeared in maestro refusal text or tool-call args across the three
 * benched candidates (Gemma 4 26B-A4B + MTP, Qwen 3.6 27B Q8 + MTP,
 * Gemma 4 31B Q8 + MTP). All listed here are fail-closed: the response
 * is aborted and a t0_event captures the hit + original-content hash.
 */
export const MAESTRO_STATIC_RULES: ValuePatternRule[] = [
  {
    id: "ssh_private_key_path",
    pattern: /(?:^|[^a-zA-Z0-9])\.ssh\/(id_[a-z0-9_]+|authorized_keys|known_hosts)/g,
    replacement: "[REDACTED:ssh-key-path]",
    failClosed: true,
  },
  {
    id: "destructive_shell_rmrf",
    pattern: /\brm\s+-rf(?:\s+--[a-z][a-z0-9-]*)*\s+\/\S*/g,
    replacement: "[REDACTED:rm-rf]",
    failClosed: true,
  },
  {
    id: "git_force_push",
    pattern:
      /git\s+push\s+--force(?:-with-lease)?(?:\s+\S+){0,3}\s+(?:HEAD:)?(?:main|master|origin\/(?:main|master))/g,
    replacement: "[REDACTED:force-push]",
    failClosed: true,
  },
];

const FAIL_CLOSED_IDS = new Set<string>([
  ...MAESTRO_STATIC_RULES.filter((r) => r.failClosed).map((r) => r.id),
  WALKER_DEPTH_EXCEEDED_RULE_ID,
  "unknown_initial_agent",
]);

export function isFailClosed(ruleId: string): boolean {
  return FAIL_CLOSED_IDS.has(ruleId);
}

/**
 * Build a redaction rule that fires when chain_start's `initial_agent`
 * arg is set to a value not in the known agent registry. Sourced at
 * worker startup from maestro_capabilities; rebuild on registry
 * change.
 */
export function buildUnknownAgentRule(knownAgents: Set<string>): ValuePatternRule {
  return {
    id: "unknown_initial_agent",
    // Matches `"initial_agent":"<value>"` inside a JSON-encoded arg blob.
    pattern: /"initial_agent"\s*:\s*"([^"\\]+)"/g,
    replacement: (match: string, name: string): string => {
      if (knownAgents.has(name)) return match;
      return `"initial_agent":"[REDACTED:unknown-agent:${name}]"`;
    },
    failClosed: true,
  };
}
