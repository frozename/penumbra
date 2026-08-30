import { RegistrarCreateRequestSchema } from "@penumbra/api-contract";
import { parsePhaseHeaders, runRegistrarRegister } from "@src/commands/registrar.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "penumbra-registrar-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function planFixture(): string {
  return [
    "---",
    "plan_id: plan-registrar",
    "home_project: penumbra",
    "---",
    "",
    "# Plan Registrar Rollout",
    "",
    "## Phase 1 — Contract — schemas",
    "",
    "## Phase 2: CLI command",
    "",
  ].join("\n");
}

test("parsePhaseHeaders extracts phase titles in order from a plan markdown fixture, em-dashes preserved", () => {
  const markdown = [
    "# Plan registrar",
    "",
    "## Phase 1 — Contract — schemas",
    "",
    "## Phase 2: CLI command",
    "",
    "## Phase 3 — Verification",
  ].join("\n");

  expect(parsePhaseHeaders(markdown)).toEqual([
    "Contract — schemas",
    "CLI command",
    "Verification",
  ]);
});

test("register POSTs a body that passes RegistrarCreateRequestSchema.safeParse", async () => {
  const path = join(workDir, "2026-08-26-plan-registrar.md");
  await writeFile(path, planFixture(), "utf8");
  let capturedBody: unknown;
  let capturedMethod: string | undefined;
  let capturedUrl: string | undefined;
  const output: string[] = [];

  const fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    capturedMethod = init?.method;
    capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
    return Promise.resolve(
      new Response(JSON.stringify({ registrar_id: "registrar-1" }), { status: 201 }),
    );
  };

  const code = await runRegistrarRegister({
    path,
    storageRoot: workDir,
    fetch,
    out: (line) => output.push(line),
    err: () => undefined,
  });

  expect(code).toBe(0);
  expect(capturedUrl).toBe("/registrar");
  expect(capturedMethod).toBe("POST");
  expect(output).toEqual(["registrar-1"]);
  expect(RegistrarCreateRequestSchema.safeParse(capturedBody).success).toBe(true);
  expect(capturedBody).toEqual({
    title: "Plan Registrar Rollout",
    slug: "plan-registrar",
    home_project: "penumbra",
    phases: ["Contract — schemas", "CLI command"],
    source_doc_path: path,
    status: "active",
  });
});

test("a plan doc path that does not exist exits non-zero and never POSTs", async () => {
  const path = join(workDir, "missing-plan.md");
  let postCount = 0;
  const errors: string[] = [];

  const code = await runRegistrarRegister({
    path,
    storageRoot: workDir,
    fetch: () => {
      postCount += 1;
      return Promise.resolve(new Response(null, { status: 201 }));
    },
    out: () => undefined,
    err: (line) => errors.push(line),
  });

  expect(code).not.toBe(0);
  expect(postCount).toBe(0);
  expect(errors.join("\n")).toContain(path);
});

test("a daemon error exits non-zero and writes the failure to stderr", async () => {
  const path = join(workDir, "2026-08-26-plan-registrar.md");
  await writeFile(path, planFixture(), "utf8");
  const errors: string[] = [];

  const code = await runRegistrarRegister({
    path,
    storageRoot: workDir,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "registrar_storage_unavailable" }), { status: 503 }),
      ),
    out: () => undefined,
    err: (line) => errors.push(line),
  });

  expect(code).not.toBe(0);
  expect(errors.join("\n")).toContain("HTTP 503");
  expect(errors.join("\n")).toContain("registrar_storage_unavailable");
});

test("re-registering the same slug surfaces the daemon's slug-taken 409 as a clean 'already registered' message, exit 0, no duplicate POST retry", async () => {
  const path = join(workDir, "2026-08-26-plan-registrar.md");
  await writeFile(path, planFixture(), "utf8");
  let postCount = 0;
  const output: string[] = [];
  const errors: string[] = [];

  const code = await runRegistrarRegister({
    path,
    storageRoot: workDir,
    fetch: () => {
      postCount += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "registrar_slug_taken", slug: "plan-registrar" }), {
          status: 409,
        }),
      );
    },
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  });

  expect(code).toBe(0);
  expect(postCount).toBe(1);
  expect(output.join("\n")).toBe("already registered: plan-registrar");
  expect(errors).toEqual([]);
});

test("the CLI command registry dispatches registrar register", async () => {
  const path = join(workDir, "missing-plan.md");
  const child = Bun.spawn(
    [process.execPath, "packages/cli/bin/penumbra.ts", "registrar", "register", path],
    {
      cwd: process.cwd(),
      env: { ...process.env, PENUMBRA_STORAGE_ROOT: workDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(exitCode).toBe(2);
  expect(stderr).toContain(`penumbra registrar register: cannot read ${path}`);
});
