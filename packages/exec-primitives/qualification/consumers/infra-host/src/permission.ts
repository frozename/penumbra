/**
 * Infra-host permission surface: an infra consumer has no operator prompt UI,
 * so every permission request resolves "reject" (fail-closed by policy) — and
 * with no decide wired at all the packed handler must still default to
 * cancellation. Both shapes are exercised by the contract suite.
 */
import {
  type ExecLogger,
  handleStdioAcpPermissionRequest,
  type PermissionDecideRequest,
  type PermissionHost,
  StdioAcpPermissionContext,
} from "penumbra-exec-primitives";

export const INFRA_DISPATCH_ID = "infra-dispatch";

/**
 * Deny-by-default permission host. decide() reads its policy off `this`, so a
 * caller that forgets to bind (host.decide detached and invoked bare) throws —
 * which the packed handler must still convert into a rejection, never an
 * approval.
 */
export class DenyAllPermissionHost implements PermissionHost {
  readonly signal: AbortSignal;
  readonly dispatchId: string;
  readonly logger: ExecLogger | undefined;
  private readonly policy = "reject" as const;

  constructor(signal: AbortSignal, logger?: ExecLogger) {
    this.signal = signal;
    this.dispatchId = INFRA_DISPATCH_ID;
    this.logger = logger;
  }

  decide(_req: PermissionDecideRequest): "approve" | "reject" {
    return this.policy;
  }
}

export function denyAllHost(signal: AbortSignal): DenyAllPermissionHost {
  return new DenyAllPermissionHost(signal);
}

/** No decide callback at all — the packed handler must fail closed. */
export function unhandledHost(signal: AbortSignal): PermissionHost {
  return { signal, dispatchId: INFRA_DISPATCH_ID };
}

export async function denyAllPermission(
  signal: AbortSignal,
  context: StdioAcpPermissionContext,
  wireRequest: Parameters<typeof handleStdioAcpPermissionRequest>[2],
): Promise<unknown> {
  return handleStdioAcpPermissionRequest(denyAllHost(signal), context, wireRequest);
}

export { StdioAcpPermissionContext };
