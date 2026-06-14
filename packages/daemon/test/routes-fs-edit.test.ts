import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { worktreesEditRoute } from "../src/routes/fs.js";

function fakeServices(worktrees: Record<string, string>): any {
  return {
    worktreeManager: {
      getWorktree: (id: string) => (worktrees[id] ? { handoffId: id, path: worktrees[id] } : null),
    },
    handoffReader: {
      get: () => null,
    },
  };
}

describe("worktrees edit route", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-edit-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("replaces a single unique occurrence and returns replacements:1", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "hello world\n");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "hello", new_string: "goodbye" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("file.txt");
    expect(body.replacements).toBe(1);
    expect(fs.readFileSync(path.join(tmp, "file.txt"), "utf8")).toBe("goodbye world\n");
  });

  it("replaces all occurrences when replace_all is true", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "a a a");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({
        path: "file.txt",
        old_string: "a",
        new_string: "b",
        replace_all: true,
      }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replacements).toBe(3);
    expect(fs.readFileSync(path.join(tmp, "file.txt"), "utf8")).toBe("b b b");
  });

  it("returns 422 string_not_found when old_string is absent", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "hello world\n");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "MISSING", new_string: "x" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("string_not_found");
  });

  it("returns 422 string_not_unique when old_string appears multiple times without replace_all", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "a a a");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "a", new_string: "b" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("string_not_unique");
    expect(body.error.message).toContain("3");
  });

  it("returns 400 no_op when old_string === new_string", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "hello world\n");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "hello", new_string: "hello" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("no_op");
  });

  it("returns 400 outside_worktree for path escape", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "hello\n");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "../outside.txt", old_string: "x", new_string: "y" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("outside_worktree");
  });

  it("returns 404 not_found when file does not exist", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "missing.txt", old_string: "x", new_string: "y" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 not_found for unknown handoff", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "x", new_string: "y" }),
    });
    const res = await worktreesEditRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns 400 invalid_args when path is missing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ old_string: "x", new_string: "y" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 400 invalid_args when old_string is missing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", new_string: "y" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 400 invalid_args when new_string is missing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "x" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_args");
  });

  it("allows new_string to be empty string", async () => {
    fs.writeFileSync(path.join(tmp, "file.txt"), "hello world\n");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/edit", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", old_string: "hello ", new_string: "" }),
    });
    const res = await worktreesEditRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replacements).toBe(1);
    expect(fs.readFileSync(path.join(tmp, "file.txt"), "utf8")).toBe("world\n");
  });
});
