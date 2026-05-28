import type { RouteAgentInput, RouteAgentOutput } from "../services/agent-routing.js";

export type RouteAgentFn = (input: RouteAgentInput) => RouteAgentOutput;
