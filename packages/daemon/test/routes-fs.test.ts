import type { Services } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { worktreesGlobRoute, worktreesGrepRoute } from "../src/routes/fs.js";

interface RouteErrorBody {
  error: {
    code: string;
  };
}

interface GlobBody {
  results: string[];
}

interface GrepBody {
  results: { text: string }[];
}

async function jsonBody<T>(res: Response): Promise<T> {
  const body: unknown = await res.json();
  return body as T;
}

function fakeServices(worktrees: Record<string, string>): Services {
  const services = {
    worktreeManager: {
      getWorktree: (id: string): { handoffId: string; path: string } | null =>
        worktrees[id] ? { handoffId: id, path: worktrees[id] } : null,
    },
    handoffReader: {
      get: (): null => null,
    },
  };
  // The route under test reads only these daemon service fields.
  return services as unknown as Services;
}

describe("worktrees fs routes", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-"));
    fs.writeFileSync(path.join(tmp, "a.ts"), "TODO\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("glob: returns 404 when handoff is unknown", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/glob", {
      method: "POST",
      body: JSON.stringify({ pattern: "*.ts" }),
    });
    const res = await worktreesGlobRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("not_found");
  });

  it("glob: returns matches on happy path", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/glob", {
      method: "POST",
      body: JSON.stringify({ pattern: "*.ts" }),
    });
    const res = await worktreesGlobRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<GlobBody>(res);
    expect(body.results).toEqual(["a.ts"]);
  });

  it("glob: returns 400 when args.path resolves outside worktree", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/glob", {
      method: "POST",
      body: JSON.stringify({ pattern: "*.ts", path: "/etc" }),
    });
    const res = await worktreesGlobRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await jsonBody<RouteErrorBody>(res);
    expect(body.error.code).toBe("outside_worktree");
  });

  it("glob: treats relative and absolute subdir paths the same in a symlinked worktree", async () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-real-"));
    const worktree = path.join(tmp, "wt");
    fs.symlinkSync(realRoot, worktree);
    fs.mkdirSync(path.join(realRoot, "subdir"));
    fs.writeFileSync(path.join(realRoot, "subdir", "a.ts"), "x");

    try {
      const services = fakeServices({ H1: worktree });
      const relativeReq = new Request("http://x/worktrees/H1/glob", {
        method: "POST",
        body: JSON.stringify({ pattern: "*.ts", path: "./subdir" }),
      });
      const absoluteReq = new Request("http://x/worktrees/H1/glob", {
        method: "POST",
        body: JSON.stringify({ pattern: "*.ts", path: path.join(realRoot, "subdir") }),
      });

      const relativeRes = await worktreesGlobRoute(relativeReq, "H1", services);
      const absoluteRes = await worktreesGlobRoute(absoluteReq, "H1", services);

      expect(relativeRes.status).toBe(200);
      expect(absoluteRes.status).toBe(200);
      expect(await jsonBody<GlobBody>(relativeRes)).toEqual(await jsonBody<GlobBody>(absoluteRes));
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("grep: returns matches on happy path", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/grep", {
      method: "POST",
      body: JSON.stringify({ pattern: "TODO", output_mode: "content" }),
    });
    const res = await worktreesGrepRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await jsonBody<GrepBody>(res);
    expect(body.results.length).toBe(1);
    expect(body.results[0].text).toBe("TODO");
  });

  it("grep: returns 404 when handoff is unknown", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/grep", {
      method: "POST",
      body: JSON.stringify({ pattern: "TODO" }),
    });
    const res = await worktreesGrepRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
  });
});
