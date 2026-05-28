import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import {
  chainStartHandler,
  ChainStartInputShape,
  type ChainStartHandlerOpts,
} from "./chain-start.js";

export function chainStartRefinedHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  const inner = chainStartHandler(daemon, opts);
  const inputSchema = z.object(ChainStartInputShape);
  return async (rawInput: unknown) => {
    // Preflight: validate input shape BEFORE incurring refiner LLM cost. A
    // malformed input (missing initial_agent / task_class, invalid enum, etc.)
    // would fail at chain_start anyway; we surface it here without paying.
    const parsed = inputSchema.parse(rawInput);
    const { refined } = await daemon.dispatchRefine(parsed.message);
    return inner({ ...parsed, message: refined });
  };
}
