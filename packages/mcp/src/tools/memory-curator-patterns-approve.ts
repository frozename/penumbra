import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const MemoryCuratorPatternsApproveInputShape = {
  pattern_id: z.string().min(1).describe("The pattern_id to approve"),
};

const Schema = z.object(MemoryCuratorPatternsApproveInputShape);

export function memoryCuratorPatternsApproveHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = Schema.parse(input);
    return toTextContent(await daemon.postCuratorPatternApprove(parsed));
  };
}
