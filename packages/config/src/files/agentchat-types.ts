import type { AgentsConfig } from "./agents.js";
import type { QuotasConfig } from "./quotas.js";
import type { RoutingConfig } from "./routing.js";

/** Composite type matching the legacy AgentChatConfig shape for split config fields. */
export interface AgentChatConfig extends AgentsConfig, RoutingConfig, QuotasConfig {}

export type { AgentsConfig, QuotasConfig, RoutingConfig };
