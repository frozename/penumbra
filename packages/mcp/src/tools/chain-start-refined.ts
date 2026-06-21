import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import {
  chainStartHandler,
  type ChainStartHandlerOpts,
  ChainStartInputShape,
  type ChainStartResult,
} from "./chain-start.js";

export function chainStartRefinedHandler(
  daemon: DaemonClient,
  opts: ChainStartHandlerOpts = {},
): (rawInput: unknown) => Promise<ChainStartResult> {
  const inner = chainStartHandler(daemon, opts);
  const inputSchema = z.object(ChainStartInputShape);
  return async (rawInput): Promise<ChainStartResult> => {
    // Preflight: validate input shape BEFORE incurring refiner LLM cost. A
    // malformed input (missing initial_agent / task_class, invalid enum, etc.)
    // would fail at chain_start anyway; we surface it here without paying.
    const parsed = inputSchema.parse(rawInput);
    const { refined } = await daemon.dispatchRefine(parsed.message);
    return await inner({ ...parsed, message: refined });
  };
}
