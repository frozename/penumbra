import { z } from "zod";

export const WorkspaceSchema = z
  .object({
    projectId: z.string().nullable(),
    branch: z.string().nullable(),
    dirty: z.number().int().nullable(),
  })
  .loose();
export type Workspace = z.infer<typeof WorkspaceSchema>;
