import type { Services } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBearerAuth } from "../src/auth.js";
import {
  worktreesEditRoute,
  worktreesExecRoute,
  worktreesGlobRoute,
  worktreesGrepRoute,
  worktreesReadRoute,
  worktreesWriteRoute,
} from "../src/routes/fs.js";

interface HandoffStub {
  to_agent?: string;
  worker_id?: string | null;
}

interface ErrorResponseBody {
  error: { code: string };
}

function stampWorkerPrincipal(req: Request, workerId: string, token: string): Request {
  const store = {
    lookup: (t: string): { token_hash: string; worker_id: string } | null =>
      t === token ? { token_hash: `hash-${workerId}`, worker_id: workerId } : null,
  };
  const auth = createBearerAuth({ token: "shared-does-not-match", workerTokenStore: store });
  const denied = auth(req);
  if (denied !== null) {
    throw new Error(`auth stamping failed for worker ${workerId}`);
  }
  return req;
}

function fakeServices(
  worktrees: Record<string, string>,
  handoffs: Record<string, HandoffStub>,
): Services {
  return {
    worktreeManager: {
      getWorktree: (id: string) => (worktrees[id] ? { handoffId: id, path: worktrees[id] } : null),
    },
    handoffReader: {
      get: (id: string) => handoffs[id] ?? null,
    },
    shellConfig: undefined,
  } as unknown as Services;
}

async function responseJson<T>(res: Response): Promise<T> {
  return await res.json();
}

describe("worktree fs routes — worker ownership enforcement", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-fs-ownership-"));
    fs.writeFileSync(path.join(tmp, "hello.txt"), "hello\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function peerRequest(url: string, body: object): Request {
    const req = new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer tok-B" },
      body: JSON.stringify(body),
    });
    return stampWorkerPrincipal(req, "worker-B", "tok-B");
  }

  const services = (): Services => fakeServices({ H_A: tmp }, { H_A: { worker_id: "worker-A" } });

  it("read: returns 403 when worker-B accesses handoff owned by worker-A", async () => {
    const req = peerRequest("http://x/worktrees/H_A/read", { path: "hello.txt" });
    const res = await worktreesReadRoute(req, "H_A", services());
    expect(res.status).toBe(403);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("write: returns 403 when worker-B accesses handoff owned by worker-A", async () => {
    const req = peerRequest("http://x/worktrees/H_A/write", { path: "x.txt", content: "bad" });
    const res = await worktreesWriteRoute(req, "H_A", services());
    expect(res.status).toBe(403);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("edit: returns 403 when worker-B accesses handoff owned by worker-A", async () => {
    const req = peerRequest("http://x/worktrees/H_A/edit", {
      path: "hello.txt",
      old_string: "hello",
      new_string: "bye",
    });
    const res = await worktreesEditRoute(req, "H_A", services());
    expect(res.status).toBe(403);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("glob: returns 403 when worker-B accesses handoff owned by worker-A", async () => {
    const req = peerRequest("http://x/worktrees/H_A/glob", { pattern: "*.txt" });
    const res = await worktreesGlobRoute(req, "H_A", services());
    expect(res.status).toBe(403);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("grep: returns 403 when worker-B accesses handoff owned by worker-A", async () => {
    const req = peerRequest("http://x/worktrees/H_A/grep", { pattern: "hello" });
    const res = await worktreesGrepRoute(req, "H_A", services());
    expect(res.status).toBe(403);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("exec: returns 403 when worker-B accesses handoff owned by worker-A", async () => {
    const req = peerRequest("http://x/worktrees/H_A/exec", { command: "echo hi" });
    const res = await worktreesExecRoute(req, "H_A", services());
    expect(res.status).toBe(403);
    const body = await responseJson<ErrorResponseBody>(res);
    expect(body.error.code).toBe("ownership_mismatch");
  });

  it("read: shared-token principal is allowed through even when handoff has worker_id", async () => {
    const sharedAuth = createBearerAuth({ token: "shared-secret" });
    const req = new Request("http://x/worktrees/H_A/read", {
      method: "POST",
      headers: { authorization: "Bearer shared-secret" },
      body: JSON.stringify({ path: "hello.txt" }),
    });
    sharedAuth(req);
    const res = await worktreesReadRoute(req, "H_A", services());
    expect(res.status).toBe(200);
  });

  it("exec: fails closed (403) when handoff row is null and caller is a worker", async () => {
    const svc = fakeServices({ H_NULL: tmp }, {});
    const req = new Request("http://x/worktrees/H_NULL/exec", {
      method: "POST",
      headers: { authorization: "Bearer tok-B" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    stampWorkerPrincipal(req, "worker-B", "tok-B");
    const res = await worktreesExecRoute(req, "H_NULL", svc);
    expect(res.status).toBe(403);
  });

  it("read: worker-A can read its own handoff", async () => {
    const req = new Request("http://x/worktrees/H_A/read", {
      method: "POST",
      headers: { authorization: "Bearer tok-A" },
      body: JSON.stringify({ path: "hello.txt" }),
    });
    stampWorkerPrincipal(req, "worker-A", "tok-A");
    const res = await worktreesReadRoute(req, "H_A", services());
    expect(res.status).toBe(200);
  });
});
