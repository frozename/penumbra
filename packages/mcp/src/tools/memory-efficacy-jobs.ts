import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const MemoryEfficacyJobsInputShape = {
  limit: z.number().optional().describe("Max jobs to return (default 20)"),
  status: z.string().optional().describe("Filter by status: pending, running, completed, failed"),
};

const MemoryEfficacyJobsSchema = z.object(MemoryEfficacyJobsInputShape).strict();

export function memoryEfficacyJobsHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = MemoryEfficacyJobsSchema.parse(input);
    return toTextContent(await daemon.memoryEfficacyJobs(parsed));
  };
}
