#!/usr/bin/env bun
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const CHECK_MODE = process.argv.includes("--check") || process.env.DIST_CHECK_STRICT === "1";

// Allow test harness to override via env; otherwise resolve relative to this script
const packagesDir = process.env.PENUMBRA_PACKAGES_DIR ?? join(import.meta.dir, "..", "packages");

function newestMtime(dir: string, ext: string): number {
  let newest = 0;
  function walk(d: string): void {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(ext)) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > newest) {
            newest = mtime;
          }
        } catch {
          // best-effort scan; skip files we cannot stat
        }
      }
    }
  }
  walk(dir);
  return newest;
}

const stale: string[] = [];
const strayArtifacts: string[] = [];

let entries;
try {
  entries = readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
} catch {
  console.error(`cannot read packages dir: ${packagesDir}`);
  process.exit(1);
}

for (const entry of entries) {
  const pkg = join(packagesDir, entry.name);
  const srcDir = join(pkg, "src");
  const distDir = join(pkg, "dist");

  if (!existsSync(srcDir) || !existsSync(distDir)) {
    continue;
  }

  const newestSrc = newestMtime(srcDir, ".ts");
  const newestDist = newestMtime(distDir, ".d.ts");

  // Skip if either side has no relevant files
  if (newestSrc === 0 || newestDist === 0) {
    continue;
  }

  if (newestSrc > newestDist) {
    stale.push(pkg);
  }
}

const ARTIFACT_SUFFIX = /(?:\.d\.ts|\.js)$/;

function siblingTsBuildInfoFiles(pkg: string): string[] {
  let children;
  try {
    children = readdirSync(pkg, { withFileTypes: true });
  } catch {
    return [];
  }
  return children
    .filter((child) => child.isFile() && child.name.endsWith(".tsbuildinfo"))
    .map((child) => join(pkg, child.name));
}

function walkStrayArtifacts(dir: string): void {
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const full = join(dir, child.name);
    if (child.isDirectory()) {
      walkStrayArtifacts(full);
      continue;
    }
    if (!child.isFile()) {
      continue;
    }
    const isArtifact = child.name.endsWith(".js") || child.name.endsWith(".d.ts");
    if (!isArtifact) {
      continue;
    }
    const baseName = child.name.replace(ARTIFACT_SUFFIX, "");
    const hasSourceSibling =
      existsSync(join(dir, `${baseName}.ts`)) || existsSync(join(dir, `${baseName}.tsx`));
    if (!hasSourceSibling) {
      continue;
    }
    strayArtifacts.push(full);
  }
}

for (const entry of entries) {
  if (entry.name === "daemon") {
    continue;
  }
  const srcDir = join(packagesDir, entry.name, "src");
  if (!existsSync(srcDir)) {
    continue;
  }
  walkStrayArtifacts(srcDir);
}

const staleTsBuildInfoFiles = stale.flatMap((pkg) => siblingTsBuildInfoFiles(pkg));

if (strayArtifacts.length > 0) {
  if (CHECK_MODE) {
    console.error(`stray src artifacts (${String(strayArtifacts.length)}):`);
    for (const p of strayArtifacts) {
      console.error(`  ${p}`);
    }
    process.exit(2);
  }
  for (const p of strayArtifacts) {
    rmSync(p, { force: true });
  }
}

if (stale.length === 0) {
  if (strayArtifacts.length === 0) {
    process.stdout.write("all dist fresh\n");
    process.exit(0);
  }
}

if (CHECK_MODE) {
  console.error(`stale dist dirs (${String(stale.length)}):`);
  for (const p of stale) {
    console.error(`  ${p}`);
  }
  if (staleTsBuildInfoFiles.length > 0) {
    console.error(`stale tsbuildinfo files (${String(staleTsBuildInfoFiles.length)}):`);
    for (const p of staleTsBuildInfoFiles) {
      console.error(`  ${p}`);
    }
  }
  process.exit(2);
}

for (const p of stale) {
  rmSync(join(p, "dist"), { recursive: true, force: true });
}
for (const p of staleTsBuildInfoFiles) {
  rmSync(p, { force: true });
}
const removedParts = [];
if (stale.length > 0) {
  removedParts.push(`${String(stale.length)} stale dist dir${stale.length === 1 ? "" : "s"}`);
}
if (staleTsBuildInfoFiles.length > 0) {
  removedParts.push(
    `${String(staleTsBuildInfoFiles.length)} stale tsbuildinfo file${
      staleTsBuildInfoFiles.length === 1 ? "" : "s"
    }`,
  );
}
if (strayArtifacts.length > 0) {
  removedParts.push(
    `${String(strayArtifacts.length)} stray src artifact${strayArtifacts.length === 1 ? "" : "s"}`,
  );
}
process.stdout.write(`removed ${removedParts.join(" and ")}\n`);
process.exit(0);
