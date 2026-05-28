import type { GateInput, GateResult } from "./index.js";

const BRAINSTORM_MARKERS = [
  /superpowers:brainstorming/i,
  /invoking the brainstorming skill/i,
  /design approved/i,
  /docs\/superpowers\/specs\//i,
];

export function verifyBrainstormFirst(input: GateInput): GateResult {
  const mem = input.conversationMemory;
  if (!mem || mem.length === 0) {
    return {
      passed: true,
      evidence: "no conversation memory provided; gate inert",
      severity: "advisory",
    };
  }
  const joined = mem.join("\n");
  const matched = BRAINSTORM_MARKERS.some((re) => re.test(joined));
  return {
    passed: matched,
    evidence: matched
      ? "brainstorm marker found"
      : "no brainstorm marker — implementation without prior brainstorm/spec",
    severity: "advisory",
  };
}
