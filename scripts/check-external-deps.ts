#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// `bun install` can exit 0 while a dependency that lives outside the registry
// (a `file:` link to a sibling checkout) never got linked, which then fails much
// later as a confusing module-resolution error deep in a test run. This script
// runs as the root `postinstall` and turns that into a loud, actionable failure.

const NON_REGISTRY_PREFIXES = ["file:", "link:", "portal:"];

// `@novaproto/*` used to be `file:` links into a sibling `nova` checkout; they
// now come from the registry, and these scopes are load-bearing enough that a
// silently unlinked install should not get as far as the first test run.
const REQUIRED_SCOPES = ["@novaproto/"];

export interface CheckedDep {
  packageDir: string;
  name: string;
  spec: string;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function needsCheck(name: string, spec: string): boolean {
  return (
    NON_REGISTRY_PREFIXES.some((prefix) => spec.startsWith(prefix)) ||
    REQUIRED_SCOPES.some((scope) => name.startsWith(scope))
  );
}

function declaredDeps(packageDir: string): CheckedDep[] {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const deps: CheckedDep[] = [];
  for (const field of DEP_FIELDS) {
    const entries = manifest[field];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [name, spec] of Object.entries(entries as Record<string, string>)) {
      if (needsCheck(name, spec)) deps.push({ packageDir, name, spec });
    }
  }
  return deps;
}

export function collectCheckedDeps(packageDirs: readonly string[]): CheckedDep[] {
  return packageDirs.flatMap((dir) => declaredDeps(dir));
}

export function findUnresolvedDeps(
  deps: readonly CheckedDep[],
  canResolve: (dep: CheckedDep) => boolean,
): CheckedDep[] {
  return deps.filter((dep) => !canResolve(dep));
}

export function describeUnresolvedDeps(deps: readonly CheckedDep[]): string {
  const lines = [
    `install is incomplete: ${String(deps.length)} declared dependency/dependencies cannot be resolved.`,
    "",
  ];
  for (const dep of deps) {
    lines.push(`  ${dep.name}@${dep.spec}  (declared by ${dep.packageDir})`);
  }
  lines.push(
    "",
    "`bun install` can exit 0 even when a dependency fails to link. Re-run",
    "`bun install` and, for a `file:`/`link:` spec, confirm the path it points at exists.",
  );
  return lines.join("\n");
}

function workspacePackageDirs(repoRoot: string): string[] {
  const dirs: string[] = [];
  for (const root of [join(repoRoot, "packages"), join(repoRoot, "packages", "integrations")]) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(root, entry.name));
    }
  }
  return dirs;
}

function resolvesOnDisk(dep: CheckedDep): boolean {
  const nonRegistryPrefix = NON_REGISTRY_PREFIXES.find((p) => dep.spec.startsWith(p));
  if (nonRegistryPrefix !== undefined) {
    const target = dep.spec.slice(nonRegistryPrefix.length);
    return existsSync(isAbsolute(target) ? target : resolve(dep.packageDir, target));
  }
  try {
    Bun.resolveSync(dep.name, dep.packageDir);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const repoRoot = process.env.PENUMBRA_REPO_ROOT ?? join(import.meta.dir, "..");
  const deps = collectCheckedDeps(workspacePackageDirs(repoRoot));
  const unresolved = findUnresolvedDeps(deps, resolvesOnDisk);
  if (unresolved.length > 0) {
    console.error(describeUnresolvedDeps(unresolved));
    process.exit(1);
  }
  process.stdout.write(`all ${String(deps.length)} external dependencies resolve\n`);
}
