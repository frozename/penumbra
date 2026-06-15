import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspaceRoute } from "./workspace.js";

// packages/daemon/src/routes -> repo root is four levels up.
const REPO_ROOT = join(import.meta.dir, "../../../..");

test("workspaceRoute reports the daemon's own repo identity + git state", async () => {
  const services = { worktreeManager: { mainRepoDir: REPO_ROOT } } as never;
  const res = await workspaceRoute(new Request("http://localhost/workspace"), services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { projectId: unknown; branch: unknown; dirty: unknown };
  // penumbra is a git repo with an origin remote, so projectId resolves to a string.
  expect(typeof body.projectId).toBe("string");
  expect(typeof body.branch).toBe("string");
  expect((body.branch as string).length).toBeGreaterThan(0);
  expect(typeof body.dirty).toBe("number");
  expect(body.dirty as number).toBeGreaterThanOrEqual(0);
});

test("workspaceRoute fails closed to null when the repo path is unresolvable", async () => {
  const services = {
    worktreeManager: { mainRepoDir: "/nonexistent-repo-xyz-123" },
  } as never;
  const res = await workspaceRoute(new Request("http://localhost/workspace"), services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { projectId: unknown; branch: unknown; dirty: unknown };
  // git fails on the nonexistent path -> both git-derived fields are null, never
  // fabricated. projectId is environment-dependent (marker walk-up), so allow
  // null or a string but never anything else.
  expect(body.branch).toBeNull();
  expect(body.dirty).toBeNull();
  expect(body.projectId === null || typeof body.projectId === "string").toBe(true);
});
