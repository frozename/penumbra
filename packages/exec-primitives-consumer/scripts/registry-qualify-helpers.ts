import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { LOCK_ENTRY } from "../src/pin.ts";

export interface BunTestSummary {
  pass: number;
  fail: number;
  files: number;
}

export function parseBunSummary(output: string): BunTestSummary {
  const passLines = output.match(/^ *\d+ pass$/gm) ?? [];
  const failLines = output.match(/^ *\d+ fail$/gm) ?? [];
  const ranMatches = [...output.matchAll(/Ran (\d+) tests? across (\d+) files?/g)];
  const ranMatch = ranMatches.at(-1);
  const pass =
    passLines.length > 0 ? parseInt(passLines[passLines.length - 1]!.replace(/\D/g, ""), 10) : 0;
  const fail =
    failLines.length > 0 ? parseInt(failLines[failLines.length - 1]!.replace(/\D/g, ""), 10) : 0;
  const files = ranMatch ? parseInt(ranMatch[2] ?? "0", 10) : 0;
  return { pass, fail, files };
}

export function computeDigest(dir: string): string {
  const files: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(relative(dir, full));
    }
  }
  walk(dir);
  files.sort();
  const lines = files.map(
    (f) =>
      `${f}\t${createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex")}`,
  );
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface TarballHashes {
  sha256: string;
  sha1: string;
  integrity: string;
}

export function computeTarballHashes(buf: Buffer): TarballHashes {
  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    sha1: createHash("sha1").update(buf).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(buf).digest("base64")}`,
  };
}

export function validatePublishedManifest(m: Record<string, unknown>): string[] {
  const bad: string[] = [];
  const s = JSON.stringify(m);
  if (m["name"] !== "@novaproto/exec-primitives" || m["version"] !== "0.1.0")
    bad.push("name/version");
  if ("private" in m) bad.push("private");
  if (m["license"] !== "MIT") bad.push("license");
  for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (k in m) bad.push(k);
  }
  for (const tok of ["0.0.0", "@penumbra/", "workspace:", "file:", "link:"]) {
    if (s.includes(tok)) bad.push(tok);
  }
  return bad;
}

export function hasLockEntry(lock: string, entry = LOCK_ENTRY): boolean {
  return lock.includes(entry);
}
