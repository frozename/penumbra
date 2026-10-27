import { z } from "zod";

export const GithubRemoteSchema = z.object({
  kind: z.literal("github"),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

export const RemoteSchema = z.discriminatedUnion("kind", [GithubRemoteSchema]);

export const ReconcileModeSchema = z.enum(["off", "git-only", "full"]);
export type ReconcileMode = z.infer<typeof ReconcileModeSchema>;

export const ProjectEntrySchema = z.object({
  project_id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, "invalid project_id"),
  root_path: z.string().min(1),
  gh_repo: z
    .string()
    .min(1)
    .regex(/^[^/\s]+\/[^/\s]+$/, "gh_repo must be owner/name")
    .optional(),
  remote: RemoteSchema.optional(),
  dreaming: z
    .object({
      allowed_domains: z.array(z.string()).optional(),
      research_provider: z.enum(["firecrawl", "webfetch", "off"]).optional(),
    })
    .optional(),
  reconcile: ReconcileModeSchema.optional(),
  // #233: per-project override of the worker's reconcilerAutoRebase; unset uses the global flag.
  auto_rebase: z.boolean().optional(),
});

export const ProjectRegistryFileSchema = z.object({
  projects: z.array(ProjectEntrySchema),
});

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;
export type ProjectRegistryFile = z.infer<typeof ProjectRegistryFileSchema>;
export type ResolvedProjectEntry = ProjectEntry & { canonical_root_path?: string };

export function getGithubRepo(entry: ProjectEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if (entry.remote?.kind === "github") return entry.remote.repo;
  return entry.gh_repo;
}

// Unset means "full": the pre-#233 reconcile behaviour.
export function reconcileModeOf(entry: Pick<ProjectEntry, "reconcile"> | undefined): ReconcileMode {
  return entry?.reconcile ?? "full";
}
