import type { Services } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { worktreesReadRoute } from "../src/routes/fs.js";

interface ReadResponseBody {
  bytes: number;
  content: string;
  path: string;
  truncated: boolean;
}

interface ErrorResponseBody {
  error: { code: string };
}

function fakeServices(worktrees: Record<string, string>): Services {
  return {
    worktreeManager: {
      getWorktree: (id: string) => (worktrees[id] ? { handoffId: id, path: worktrees[id] } : null),
    },
    handoffReader: {
      get: () => null,
    },
  } as unknown as Services;
}

async function responseJson<T>(res: Response): Promise<T> {
  return await res.json();
}

describe("worktrees read route", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-read-"));
    fs.writeFileSync(path.join(tmp, "hello.txt"), "hello world\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns file content on happy path", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/read", {
      method: "POST",
      body: JSON.stringify({ path: "hello.txt" }),
    });
    const res = await worktreesReadRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await responseJson<ReadResponseBody>(res);
    expect(body.content).toBe("hello world\n");
    expect(body.path).toBe("hello.txt");
    expect(body.bytes).toBe(12);
    expect(body.truncated).toBe(false);
  });

  it("returns 404 when handoff is unknown", async () => {
    const services = fakeServices({});
    const req = new Request("http://x/worktrees/UNKNOWN/read", {
      method: "POST",
      body: JSON.stringify({ path: "hello.txt" }),
    });
    const res = await worktreesReadRoute(req, "UNKNOWN", services);
    expect(res.status).toBe(404);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("not_found");
  });

  it("returns 400 when path is missing from body", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/read", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await worktreesReadRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("invalid_args");
  });

  it("returns 400 when path escapes the worktree", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/read", {
      method: "POST",
      body: JSON.stringify({ path: "../outside.txt" }),
    });
    const res = await worktreesReadRoute(req, "H1", services);
    expect(res.status).toBe(400);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("outside_worktree");
  });

  it("returns 404 when file does not exist", async () => {
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/read", {
      method: "POST",
      body: JSON.stringify({ path: "missing.txt" }),
    });
    const res = await worktreesReadRoute(req, "H1", services);
    expect(res.status).toBe(404);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("not_found");
  });

  it("truncates and flags files larger than 1 MiB", async () => {
    const bigContent = "x".repeat(1024 * 1024 + 100);
    fs.writeFileSync(path.join(tmp, "big.txt"), bigContent);
    const services = fakeServices({ H1: tmp });
    const req = new Request("http://x/worktrees/H1/read", {
      method: "POST",
      body: JSON.stringify({ path: "big.txt" }),
    });
    const res = await worktreesReadRoute(req, "H1", services);
    expect(res.status).toBe(200);
    const body = await responseJson<ReadResponseBody>(res);
    expect(body.truncated).toBe(true);
    expect(body.bytes).toBe(Buffer.byteLength(bigContent, "utf8"));
    expect(body.content.length).toBe(1024 * 1024);
  });
});
