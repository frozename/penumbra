import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const HANDOFF_INSERT_RE = /INSERT\s+INTO\s+handoffs\b/i;
const PRUNED_DIR_NAMES = new Set(["dist", "node_modules", "test", "tests", "__tests__"]);

function isSourceTsFile(entryName: string, relPath: string): boolean {
  return (
    (entryName.endsWith(".ts") || entryName.endsWith(".tsx")) &&
    relPath.split("/").includes("src") &&
    !relPath.endsWith(".test.ts") &&
    !relPath.endsWith(".test.tsx")
  );
}

export function sqlWritesHandoffStatus(source: string): boolean {
  const updateStartRe = /UPDATE\s+handoffs\s+SET/gi;
  const statusSetRe = /\bstatus\s*=/i;
  let match: RegExpExecArray | null;

  while ((match = updateStartRe.exec(source)) !== null) {
    const afterSetStart = match.index + match[0].length;
    const afterSet = source.slice(afterSetStart);
    const whereMatch = /\bWHERE\b/i.exec(afterSet);
    const setEnd =
      whereMatch !== null
        ? whereMatch.index
        : findContainingLiteralEnd(source, match.index) - afterSetStart;
    const setClause = afterSet.slice(0, setEnd);
    if (statusSetRe.test(setClause)) return true;
  }

  return false;
}

function findContainingLiteralEnd(source: string, sqlStart: number): number {
  for (let index = sqlStart - 1; index >= 0; index--) {
    const quote = source[index];
    if (quote === "`" || quote === "'" || quote === '"') {
      const end = source.indexOf(quote, sqlStart);
      return end >= 0 ? end : source.length;
    }
  }
  return source.length;
}

export function listSourceTsFiles(packagesRoot: string): string[] {
  const files: string[] = [];

  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNED_DIR_NAMES.has(entry.name)) continue;
        walk(absPath);
        continue;
      }
      if (entry.isFile()) {
        const relPath = relative(packagesRoot, absPath);
        if (!isSourceTsFile(entry.name, relPath)) continue;
        files.push(relPath);
      }
    }
  };

  walk(packagesRoot);

  return files.sort();
}

function matchingFiles(predicate: (contents: string) => boolean): string[] {
  const repoRoot = resolve(import.meta.dir, "../../../../");
  const packagesRoot = join(repoRoot, "packages");
  return listSourceTsFiles(packagesRoot).flatMap((relPath) => {
    const repoRelPath = join("packages", relPath);
    const contents = readFileSync(join(repoRoot, repoRelPath), "utf8");
    return predicate(contents) ? [repoRelPath] : [];
  });
}

function touchFixture(root: string, relPath: string): void {
  const absPath = join(root, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, "export const marker = true;\n");
}

test("sqlWritesHandoffStatus matches handoffs status writes in the SET clause", () => {
  expect(
    sqlWritesHandoffStatus(
      "UPDATE handoffs SET resolution_reason='x', status='failed' WHERE handoff_id=?",
    ),
  ).toBe(true);
  expect(
    sqlWritesHandoffStatus(
      "UPDATE handoffs\n  SET\n    status = 'expired',\n    resolved_at = ?1\n  WHERE status = 'pending'",
    ),
  ).toBe(true);
  expect(sqlWritesHandoffStatus("UPDATE handoffs SET status=? WHERE id=?")).toBe(true);
});

test("sqlWritesHandoffStatus ignores non-status handoff writes and other tables", () => {
  expect(
    sqlWritesHandoffStatus(
      "UPDATE handoffs SET open_pr_on_review=? WHERE handoff_id=? AND status='dispatched'",
    ),
  ).toBe(false);
  expect(sqlWritesHandoffStatus("UPDATE handoffs SET branch_name = ? WHERE handoff_id = ?")).toBe(
    false,
  );
  expect(
    sqlWritesHandoffStatus(
      "UPDATE handoffs SET cancel_requested_at=? WHERE conversation_id=? AND cancel_requested_at IS NULL",
    ),
  ).toBe(false);
  expect(sqlWritesHandoffStatus("UPDATE dream_actions SET status='failed' WHERE action_id=?")).toBe(
    false,
  );
});

test("the walker visits nested workspace src dirs and prunes dist/node_modules", () => {
  const packagesRoot = mkdtempSync(join(tmpdir(), "handoff-write-sites-"));
  touchFixture(packagesRoot, "alpha/src/a.ts");
  touchFixture(packagesRoot, "integrations/beta/src/b.ts");
  touchFixture(packagesRoot, "alpha/dist/c.ts");
  touchFixture(packagesRoot, "alpha/node_modules/x/src/d.ts");
  touchFixture(packagesRoot, "alpha/test/e.test.ts");

  expect(listSourceTsFiles(packagesRoot)).toEqual(["alpha/src/a.ts", "integrations/beta/src/b.ts"]);
});

test("the only file that writes handoffs.status via UPDATE is the HandoffWriter", () => {
  expect(matchingFiles(sqlWritesHandoffStatus)).toEqual(["packages/core/src/writers/handoff.ts"]);
});

test("the only file that inserts into handoffs is the HandoffWriter", () => {
  expect(matchingFiles((contents) => HANDOFF_INSERT_RE.test(contents))).toEqual([
    "packages/core/src/writers/handoff.ts",
  ]);
});
