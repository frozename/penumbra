import { z } from "zod";

import { PACKAGE_MANAGERS } from "../worktree/install-command.js";

export const GithubRemoteSchema = z.object({
  kind: z.literal("github"),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

export const RemoteSchema = z.discriminatedUnion("kind", [GithubRemoteSchema]);

export const ReconcileModeSchema = z.enum(["off", "git-only", "full"]);
export type ReconcileMode = z.infer<typeof ReconcileModeSchema>;

export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);

// A verify command runs without a shell: it is split on single spaces into an
// argv. Quotes, pipes, redirects, `&&` and VAR=value prefixes are rejected so
// nobody writes one that only a shell would understand. `=` is allowed after
// the first word, for --flag=value arguments.
const VERIFY_FIRST_WORD = "[A-Za-z0-9_@%+:,./-]+";
const VERIFY_WORD = "[A-Za-z0-9_@%+:,./=-]+";
export const VerifyCommandSchema = z
  .string()
  .regex(
    new RegExp(`^${VERIFY_FIRST_WORD}( ${VERIFY_WORD})*$`),
    "verify command must be plain words separated by single spaces (it runs without a shell)",
  );

export const VerifyCommandsSchema = z.strictObject({
  typecheck: z.array(VerifyCommandSchema).min(1),
  tests: z.array(VerifyCommandSchema).min(1),
});
export type VerifyCommands = z.infer<typeof VerifyCommandsSchema>;

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
  post_implementation_reviewer: z.string().trim().min(1).max(200).optional(),
  // #233: per-project override of the worker's reconcilerAutoRebase; unset uses the global flag.
  auto_rebase: z.boolean().optional(),
  // Isolated-install worktrees install with this instead of detecting the lockfile.
  package_manager: PackageManagerSchema.optional(),
  // The project's own gate: the reconciler runs these in the worktree in place
  // of its bun typecheck and bun test stages.
  verify: VerifyCommandsSchema.optional(),
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

export interface VerifyArgv {
  typecheck: [string, ...string[]][];
  tests: [string, ...string[]][];
}

// Unset means the reconciler's built-in bun typecheck and bun test stages.
export function verifyArgvOf(
  entry: Pick<ProjectEntry, "verify"> | undefined,
): VerifyArgv | undefined {
  const verify = entry?.verify;
  if (!verify) return undefined;
  const toArgv = (command: string): [string, ...string[]] =>
    command.split(" ") as [string, ...string[]];
  return { typecheck: verify.typecheck.map(toArgv), tests: verify.tests.map(toArgv) };
}
