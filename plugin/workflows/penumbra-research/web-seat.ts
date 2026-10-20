import type { WorkflowCtx } from "@penumbra/workflows";

type ConfigLike = WorkflowCtx["config"];

export type WebSeatResolution =
  | { ok: true; agent: string }
  | { ok: false; error: "no_web_capable_seat" };

const WORKLOAD_KEY = "web_research";

// Resolve the web-capable agent seat. Explicit caller web_agent wins; otherwise
// read config.workloads.web_research.eligible_agents (duck-typed, verified shape).
// No fabricated seat, no off-adapter/local-network fallback. The strict
// WorkloadsConfigSchema does not list web_research, so by default this returns
// no_web_capable_seat — fail-closed unless the operator opts in.
export function resolveWebSeat(
  config: ConfigLike,
  webAgent: string | undefined,
): WebSeatResolution {
  const explicit = typeof webAgent === "string" ? webAgent.trim() : "";
  if (explicit.length > 0) return { ok: true, agent: explicit };

  const workloads = config.workloads;
  if (!workloads || typeof workloads !== "object" || Array.isArray(workloads)) {
    return { ok: false, error: "no_web_capable_seat" };
  }
  const workload = (workloads as Record<string, unknown>)[WORKLOAD_KEY];
  if (!workload || typeof workload !== "object" || Array.isArray(workload)) {
    return { ok: false, error: "no_web_capable_seat" };
  }
  const raw = (workload as Record<string, unknown>).eligible_agents;
  if (!Array.isArray(raw)) return { ok: false, error: "no_web_capable_seat" };
  const agents = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  const [first] = agents;
  if (!first) return { ok: false, error: "no_web_capable_seat" };
  return { ok: true, agent: first };
}
