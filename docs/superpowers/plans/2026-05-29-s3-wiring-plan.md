# Design decision spec & execution plan — sharing one HandleStore across workflow_wait + read_handle (S3 wiring)

**Date:** 2026-05-29
**Status:** Completed

## 1. Selected Wiring

**Wiring B (synthesis with A):** The `TOOL_REGISTRY` mapping was updated so that `ToolDef["makeHandler"]` takes an optional `ServerCtx` (which holds the `HandleStore`), and maps that context through `handlerOpts` if defined.

**Justification against constraints:**
- **Same `HandleStore` instance shared**: Both `read_handle` and `workflow_wait` receive the same `ServerCtx` injected by `buildServer`.
- **No module-level global store**: `HandleStore` remains instantiated inside `buildServer`s function scope, preserving reentrancy and isolation.
- **Keep `instrumentHandler` wrapping + allowlist gating**: By bringing `read_handle` into `RAW_TOOL_REGISTRY`, it goes through the standard `for` loop, eliminating the special casing and making sure it inherits all default `instrumentHandler` behavior automatically.
- **Minimize churn to `server.test.ts`**: We only had to remove `"read_handle"` from the expected tool list since its now naturally part of `Object.keys(TOOL_REGISTRY)`.
- **`withActingOnEnvelope` behavior preserved**: The wrapper still wraps the handler just like before.

## 2. Execution Phases

### Phase 1: Context Wiring
- **Action**: Defined `ServerCtx` containing `HandleStore`. Modified `ToolDef` signature so that `makeHandler` accepts `opts?: any` (allowing `ServerCtx` fallback).
- **Action**: Modified `TOOL_REGISTRY` inside `packages/mcp/src/tools/registry.ts` to pass `ctx` through `def.handlerOpts?.(ctx)`.
- **Action**: Updated `buildServer` inside `packages/mcp/src/server.ts` to instantiate `handleStore` and inject it into `def.makeHandler(daemon, serverCtx)`.
- **Validation**: Verified that `server.test.ts` passes.

### Phase 2: Daemon Boundary Reversion
- **Action**: Reverted the S2 cap in `packages/daemon/src/routes/workflows.ts`. `workflowsWaitRoute` now passes `status.result` and `status.error` un-truncated back to the MCP layer. Removed unused constants (`WORKFLOW_WAIT_PAYLOAD_LIMIT`) and `buildPayloadPreview` from daemon-side.

### Phase 3: MCP-side Bounding (S3)
- **Action**: Modified `workflowWaitHandler` in `packages/mcp/src/tools/workflow-status.ts` to accept `ctx?: { handleStore: HandleStore }`.
- **Action**: Bound results and errors > `DEFAULT_BUDGET` using `HandleStore.put(serialized)`. Truncated outputs include `_meta: { handle_id }` for seamless downstream consumption.
- **Action**: Registered `handlerOpts` for `workflow_wait` inside `packages/mcp/src/tools/registry.ts` to extract `ctx.handleStore`.

### Phase 4: `read_handle` Unification
- **Action**: Brought `read_handle` directly into `RAW_TOOL_REGISTRY`. Its `makeHandler` unpacks `ctx!.handleStore`.
- **Action**: Deleted the out-of-loop special case for `read_handle` in `server.ts`.
- **Action**: Updated `packages/mcp/test/server.test.ts` expectation to reflect `read_handle` now being part of `TOOL_REGISTRY`.

## 3. Operational Notes

1. **Daemon Restart Required**: The daemon must be restarted (`penumbra daemon reload` or restart process) for the unbounded `workflow_wait` boundary change to take effect. If its not restarted, the MCP layer will just never see payloads larger than the old daemon limit.
2. **BOUNDARY Review**: As noted in the specs, this is a boundary contract change shifting truncation responsibility entirely to the MCP shim.