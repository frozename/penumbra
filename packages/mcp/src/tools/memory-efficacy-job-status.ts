import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const MemoryEfficacyJobStatusInputShape = {
  job_id: z.string().describe("The job_id returned by memory.efficacy_rebuild"),
};

const MemoryEfficacyJobStatusSchema = z.object(MemoryEfficacyJobStatusInputShape).strict();

export function memoryEfficacyJobStatusHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = MemoryEfficacyJobStatusSchema.parse(input);
    return toTextContent(await daemon.memoryEfficacyJobStatus(parsed));
  };
}
