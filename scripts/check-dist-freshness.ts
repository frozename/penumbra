#!/usr/bin/env bun
import { readdirSync, statSync, rmSync, existsSync } from "fs";
import { join } from "path";

const CHECK_MODE = process.argv.includes("--check") || process.env.DIST_CHECK_STRICT === "1";

// Allow test harness to override via env; otherwise resolve relative to this script
const packagesDir = process.env.PENUMBRA_PACKAGES_DIR ?? join(import.meta.dir, "..", "packages");

function newestMtime(dir: string, ext: string): number {
  let newest = 0;
  function walk(d: string) {
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
          if (mtime > newest) newest = mtime;
        } catch {}
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

  if (!existsSync(srcDir) || !existsSync(distDir)) continue;

  const newestSrc = newestMtime(srcDir, ".ts");
  const newestDist = newestMtime(distDir, ".d.ts");

  // Skip if either side has no relevant files
  if (newestSrc === 0 || newestDist === 0) continue;

  if (newestSrc > newestDist) {
    stale.push(pkg);
  }
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
    if (!child.isFile()) continue;
    const isArtifact = child.name.endsWith(".js") || child.name.endsWith(".d.ts");
    if (!isArtifact) continue;
    const baseName = child.name.replace(/(\.d\.ts|\.js)$/, "");
    const hasSourceSibling =
      existsSync(join(dir, `${baseName}.ts`)) || existsSync(join(dir, `${baseName}.tsx`));
    if (!hasSourceSibling) continue;
    strayArtifacts.push(full);
  }
}

for (const entry of entries) {
  if (entry.name === "daemon") continue;
  const srcDir = join(packagesDir, entry.name, "src");
  if (!existsSync(srcDir)) continue;
  walkStrayArtifacts(srcDir);
}

if (strayArtifacts.length > 0) {
  if (CHECK_MODE) {
    console.error(`stray src artifacts (${strayArtifacts.length}):`);
    for (const p of strayArtifacts) console.error(`  ${p}`);
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
  console.error(`stale dist dirs (${stale.length}):`);
  for (const p of stale) console.error(`  ${p}`);
  process.exit(2);
}

for (const p of stale) {
  rmSync(join(p, "dist"), { recursive: true, force: true });
}
const removedParts = [];
if (stale.length > 0) {
  removedParts.push(`${stale.length} stale dist dir${stale.length === 1 ? "" : "s"}`);
}
if (strayArtifacts.length > 0) {
  removedParts.push(
    `${strayArtifacts.length} stray src artifact${strayArtifacts.length === 1 ? "" : "s"}`,
  );
}
process.stdout.write(`removed ${removedParts.join(" and ")}\n`);
process.exit(0);
