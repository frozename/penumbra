import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const LongLivedResumeInputShape = {
  id: z.string().min(1),
};

export function longLivedResumeHandler(daemon: DaemonClient) {
  return async (input: { id: string }) => toTextContent(await daemon.longLivedResume(input.id));
}
