import { z } from 'zod';

export const ProjectEntrySchema = z.object({
  project_id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, 'invalid project_id'),
  root_path: z.string().min(1),
  gh_repo: z.string().min(1).regex(/^[^/\s]+\/[^/\s]+$/, 'gh_repo must be owner/name').optional(),
});

export const ProjectRegistryFileSchema = z.object({
  projects: z.array(ProjectEntrySchema),
});

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;
export type ProjectRegistryFile = z.infer<typeof ProjectRegistryFileSchema>;
