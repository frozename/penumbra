import * as nodeFs from "node:fs";

// Indirection layer: see packages/config/src/files/node-fs.ts for rationale.
// Test-only fs surface kept out of the published src tree.
const fsCalls = {
  mkdirSync: nodeFs.mkdirSync,
  rmSync: nodeFs.rmSync,
  writeFileSync: nodeFs.writeFileSync,
};

export function ensureDir(dirPath: string): void {
  fsCalls.mkdirSync(dirPath, { recursive: true });
}

export function removeRecursive(targetPath: string): void {
  fsCalls.rmSync(targetPath, { force: true, recursive: true });
}

export function writeUtf8(filePath: string, content: string): void {
  fsCalls.writeFileSync(filePath, content);
}
