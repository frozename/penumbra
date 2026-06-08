#!/usr/bin/env node
/**
 * Local patch for gemini-cli's ACP file-not-found classification.
 *
 * Mirrors google-gemini/gemini-cli PR #26439 ("fix(acp): recognise structured
 * ENOENT codes and broader not-found phrasings"), which was closed unmerged
 * upstream. Without it, gemini-cli over ACP only treats a read failure as
 * file-not-found when the error message contains one of four exact substrings
 * (`Resource not found` / `ENOENT` / `does not exist` / `No such file`) and
 * ignores the structured `code` field. A penumbra stdio-acp error phrased as
 * `not_found` / `file not found` falls through, gemini's write-file tool then
 * returns FILE_WRITE_FAILURE instead of fileExists:false, and the agent
 * silently produces no file changes (the ~13-minute gemini-acp-flash flail).
 *
 * This expands `AcpFileSystemService.normalizeFileSystemError` to also accept a
 * structured `code === "ENOENT"` and the `not_found` / `file not found`
 * phrasings. Idempotent. Re-run after any gemini-cli upgrade (the bundle
 * filenames are content-hashed, so they change every release):
 *
 *   node scripts/patch-gemini-acp-enoent.mjs
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OLD =
  'if (errorMessage.includes("Resource not found") || errorMessage.includes("ENOENT") || errorMessage.includes("does not exist") || errorMessage.includes("No such file")) {';
const NEW =
  'if ((err && typeof err === "object" && "code" in err && err.code === "ENOENT") || errorMessage.includes("Resource not found") || errorMessage.includes("ENOENT") || errorMessage.includes("does not exist") || errorMessage.includes("No such file") || errorMessage.includes("not_found") || errorMessage.includes("file not found")) {';

function resolveBundleDir() {
  const bin = execSync('readlink -f "$(command -v gemini)"', {
    shell: "/bin/zsh",
  })
    .toString()
    .trim();
  if (!bin || !fs.existsSync(bin)) {
    throw new Error(`could not resolve the gemini binary (got: ${bin || "<empty>"})`);
  }
  return path.dirname(bin);
}

const bundleDir = resolveBundleDir();
let filesPatched = 0;
let sitesPatched = 0;
let already = 0;

for (const name of fs.readdirSync(bundleDir).filter((f) => f.endsWith(".js"))) {
  const file = path.join(bundleDir, name);
  let src = fs.readFileSync(file, "utf8");
  if (!src.includes("normalizeFileSystemError")) continue;

  if (src.includes(NEW)) {
    already++;
    console.log(`already patched: ${name}`);
    continue;
  }
  if (!src.includes(OLD)) continue;

  const sites = src.split(OLD).length - 1;
  fs.writeFileSync(`${file}.enoent.bak`, src); // one-shot backup for easy revert
  src = src.split(OLD).join(NEW);
  fs.writeFileSync(file, src);
  filesPatched++;
  sitesPatched += sites;
  console.log(`patched ${name} (${sites} site${sites === 1 ? "" : "s"})`);
}

console.log(
  `\nbundle: ${bundleDir}\nfiles patched: ${filesPatched}  sites: ${sitesPatched}  already: ${already}`,
);
if (filesPatched === 0 && already === 0) {
  console.error(
    "WARNING: no matching matcher found — gemini-cli's normalizeFileSystemError may have changed shape; re-inspect the bundle.",
  );
  process.exit(2);
}
