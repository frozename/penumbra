/**
 * Infra-host permission surface (plain JS): an infra consumer has no operator
 * prompt UI, so every permission request resolves "reject" (fail-closed by
 * policy) — and with no decide wired at all the packed handler must still
 * default to cancellation. Both shapes are exercised by the contract suite.
 */
import {
  handleStdioAcpPermissionRequest,
  StdioAcpPermissionContext,
} from "penumbra-exec-primitives";

export const INFRA_DISPATCH_ID = "infra-dispatch";

export function denyAllHost(signal) {
  return { signal, dispatchId: INFRA_DISPATCH_ID, decide: () => "reject" };
}

/** No decide callback at all — the packed handler must fail closed. */
export function unhandledHost(signal) {
  return { signal, dispatchId: INFRA_DISPATCH_ID };
}

export async function denyAllPermission(signal, context, wireRequest) {
  return handleStdioAcpPermissionRequest(denyAllHost(signal), context, wireRequest);
}

export { StdioAcpPermissionContext };
