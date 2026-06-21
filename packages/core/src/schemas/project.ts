import { z } from "zod";

import { SafeProjectIdSchema } from "./project-id.js";

export const ProjectKindSchema = z.enum(["git", "marker", "declared"]);

export const ProjectSchema = z.object({
  project_id: SafeProjectIdSchema,
  kind: ProjectKindSchema,
  git_remote: z.string().nullable(),
  git_relpath_root: z.string().nullable(),
  marker_uuid: z.string().nullable(),
  display_name: z.string().nullable(),
  first_seen_paths: z.array(z.string()),
  created_at: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;
