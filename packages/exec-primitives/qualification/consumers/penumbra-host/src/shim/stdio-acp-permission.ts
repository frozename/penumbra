/**
 * Parity shim: re-creates the legacy permission boundary over the extracted
 * `handleStdioAcpPermissionRequest` + `StdioAcpPermissionContext`.
 *
 * The legacy surface read a Penumbra DispatchInput (handoff_id, conversation.id,
 * trust_mode, requestPermission callback). This shim keeps the exact behavioral
 * contract the parity tests assert — fail-closed outcomes, session match,
 * abort-before-decide, retirement — while translating the legacy input into the
 * package's host-owned PermissionHost shape.
 */
import {
  handleStdioAcpPermissionRequest,
  selectConfigOption,
  selectTrustAllOption,
  StdioAcpPermissionContext,
  type AcpPermissionRequest,
  type PermissionResult,
} from "penumbra-exec-primitives";

export {
  handleStdioAcpPermissionRequest,
  selectConfigOption,
  selectTrustAllOption,
  StdioAcpPermissionContext,
};
export type { AcpPermissionRequest, PermissionResult };

/** Legacy-shaped input the origin adapter consumed (redeclared, host-owned). */
export interface LegacyPermissionInput {
  handoff_id?: string;
  conversation: { id: string };
  trust_mode?: string;
  signal: AbortSignal;
  requestPermission?: (req: {
    toolName: string;
    rawInput: unknown;
    dispatchId: string;
  }) => Promise<"approve" | "reject"> | "approve" | "reject";
}

export function dispatchIdOf(input: LegacyPermissionInput): string {
  return input.handoff_id ?? input.conversation.id;
}

/** Route a wire-level session/request_permission through the packed handler. */
export async function handlePermissionRequest(
  input: LegacyPermissionInput,
  context: StdioAcpPermissionContext,
  wireRequest: unknown,
): Promise<PermissionResult> {
  const dispatchId = dispatchIdOf(input);
  const decide =
    input.requestPermission === undefined
      ? undefined
      : async (req: { toolName: string; rawInput: unknown }) =>
          (await input.requestPermission?.({
            toolName: req.toolName,
            rawInput: req.rawInput,
            dispatchId,
          })) ?? "reject";
  return handleStdioAcpPermissionRequest(
    { signal: input.signal, dispatchId, ...(decide ? { decide } : {}) },
    context,
    wireRequest,
  );
}
