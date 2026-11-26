import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDirTracker(): { make(prefix: string): string; cleanup(): void } {
  const paths: string[] = [];

  return {
    make(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      paths.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const path of paths) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* best-effort: path may already be gone */
        }
      }
      paths.splice(0);
    },
  };
}
