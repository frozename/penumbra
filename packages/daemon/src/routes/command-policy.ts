import { z } from "zod";

import type { DaemonServices } from "../serve.js";
import type {
  InProcessPermissionDecision,
  InProcessPermissionRequestInput,
} from "../services/in-process-permission-service.js";

export type ShellConfig = NonNullable<DaemonServices["shellConfig"]>;

export type CommandPermissionToolName = "shell_run" | "shell_run.dangerous";

type PermissionService = {
  requestPermission(input: InProcessPermissionRequestInput): Promise<InProcessPermissionDecision>;
};

type ShellDaemonServices = DaemonServices & {
  permissionService?: PermissionService;
};

const ShellAgentchatConfigSchema = z.looseObject({
  agents: z
    .array(
      z.looseObject({
        auto_approve_to: z.unknown().optional(),
        name: z.string(),
      }),
    )
    .optional(),
});

function autoApproveTargetsForAgent(agentchatConfig: unknown, agentName: string): unknown {
  const parsed = ShellAgentchatConfigSchema.safeParse(agentchatConfig);
  if (!parsed.success) {
    return undefined;
  }

  const cfg = parsed.data.agents?.find((agent) => agent.name === agentName);
  return cfg?.auto_approve_to;
}

/**
 * Shared command execution gate. Both the shell_run route and the fs_exec route
 * funnel through this so the two execution surfaces enforce identical
 * approval/trust policy: unattended dispatches whose agent auto-approves
 * `shell_run` skip the prompt, everyone else raises a permission request via the
 * in-process permission service (fail-closed when no service is wired).
 */
export async function requestCommandPermission(
  services: DaemonServices,
  input: {
    handoffId: string;
    agentName: string;
    toolName: CommandPermissionToolName;
    context: Record<string, unknown>;
    signal?: AbortSignal;
  },
): Promise<"approve" | "reject"> {
  const shellServices = services as ShellDaemonServices;
  const permissionService = shellServices.permissionService;
  const autoApproveTo = autoApproveTargetsForAgent(services.agentchatConfig, input.agentName);
  if (
    input.toolName === "shell_run" &&
    Array.isArray(autoApproveTo) &&
    autoApproveTo.includes("shell_run")
  ) {
    return "approve";
  }
  if (!permissionService) {
    return "reject";
  }

  const decision = await permissionService.requestPermission({
    parent_handoff_id: input.handoffId,
    agent_name: input.agentName,
    tool_name: input.toolName,
    context: input.context,
    signal: input.signal,
  });
  return decision.approved ? "approve" : "reject";
}

export function matchedDangerousPatterns(
  shellConfig: ShellConfig,
  agentName: string,
  command: string,
): string[] {
  const dangerousPatterns = shellConfig.dangerousCommandsForAgent(agentName);
  const normalizedCommand = command.replaceAll(/\s+/g, " ");
  return dangerousPatterns.filter((pattern) => {
    try {
      return new RegExp(pattern).test(normalizedCommand);
    } catch (err) {
      console.warn(`[command-policy] Malformed dangerous command pattern "${pattern}":`, err);
      return true; // Fail closed
    }
  });
}
