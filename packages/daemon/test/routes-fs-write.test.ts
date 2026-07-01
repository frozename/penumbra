import type { Services } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { worktreesWriteRoute } from "../src/routes/fs.js";

function fakeServices(worktrees: Record<string, string>): Services {
  // typed mock factory for tests
  return {
    worktreeManager: {
      getWorktree: (id: string) => (worktrees[id] ? { handoffId: id, path: worktrees[id] } : null),
    },
    handoffReader: {
      get: () => null,
    },
  } as unknown as Services;
}

describe("worktrees write route", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-write-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a new file and returns created:true", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/write", {
      method: "POST",
      body: JSON.stringify({ path: "new.txt", content: "hello world\n" }),
    });
    const res = await worktreesWriteRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; bytes_written: number; created: boolean };
    expect(body.path).toBe("new.txt");
    expect(body.bytes_written).toBe(12);
    expect(body.created).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "new.txt"), "utf8")).toBe("hello world\n");
  });

  it("creates missing parent directories", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/write", {
      method: "POST",
      body: JSON.stringify({ path: "subdir/nested/file.txt", content: "nested content" }),
    });
    const res = await worktreesWriteRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean };
    expect(body.created).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "subdir/nested/file.txt"), "utf8")).toBe(
      "nested content",
    );
  });

  it("overwrites an existing file and returns created:false", async () => {
    fs.writeFileSync(path.join(tmp, "existing.txt"), "old content");
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/write", {
      method: "POST",
      body: JSON.stringify({ path: "existing.txt", content: "new content" }),
    });
    const res = await worktreesWriteRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean };
    expect(body.created).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "existing.txt"), "utf8")).toBe("new content");
  });

  it("returns 400 for path escaping the worktree", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/write", {
      method: "POST",
      body: JSON.stringify({ path: "../outside.txt", content: "bad" }),
    });
    const res = await worktreesWriteRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("outside_worktree");
  });

  it("does not create directories outside worktree via in-worktree symlink (TOCTOU)", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-write-outside-"));
    try {
      fs.symlinkSync(outsideDir, path.join(tmp, "link"));

      const services = fakeServices({ H1: tmp });
      const req = new Request("http://x/worktrees/H1/write", {
        method: "POST",
        body: JSON.stringify({ path: "link/newdir/file.txt", content: "bad" }),
      });
      const res = await worktreesWriteRoute(req, "H1", services);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("outside_worktree");
      expect(fs.existsSync(path.join(outsideDir, "newdir"))).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns 400 when path is missing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/write", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    const res = await worktreesWriteRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 400 when content is missing", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/write", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt" }),
    });
    const res = await worktreesWriteRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 404 when handoff is unknown", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/write", {
      method: "POST",
      body: JSON.stringify({ path: "file.txt", content: "hi" }),
    });
    const res = await worktreesWriteRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
