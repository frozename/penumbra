import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStatusline } from "@src/commands/statusline.js";

const CACHE_PATH = "/tmp/penumbra-statusline.cache";
let storageRoot = "";

interface MockDaemonResponse {
  dispatchedHandoffs: number;
  pendingPermissions: number;
  doneInLastHour: number;
}

function makeMockFetch(response: MockDaemonResponse | "offline"): typeof globalThis.fetch {
  return () => {
    if (response === "offline") return Promise.reject(new Error("connect ECONNREFUSED"));
    // simulate three daemon route calls — we don't actually distinguish here, just return
    // a synthetic merged response
    const body = {
      handoffs: Array<{ status: string }>(response.dispatchedHandoffs).fill({
        status: "dispatched",
      }),
      permissions: Array<{ status: string }>(response.pendingPermissions).fill({
        status: "pending",
      }),
      done: response.doneInLastHour,
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

describe("penumbra statusline", () => {
  beforeEach(async () => {
    try {
      await unlink(CACHE_PATH);
    } catch {
      /* cache may not exist */
    }
    process.env.NO_COLOR = "1";
    storageRoot = mkdtempSync(join(tmpdir(), "penumbra-statusline-"));
    writeFileSync(join(storageRoot, "port"), "4242\n");
    writeFileSync(join(storageRoot, "token"), "tok\n");
    process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.PENUMBRA_STORAGE_ROOT;
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  test("cache hit returns cached line without daemon call", async () => {
    const cached = "◌ penumbra  3 dispatched  12 done";
    await writeFile(CACHE_PATH, JSON.stringify({ ts: Date.now(), line: cached }));
    let fetchCalls = 0;
    const out = await runStatusline({
      fetch: () => {
        fetchCalls++;
        throw new Error("shouldnt-call");
      },
    });
    expect(out).toBe(cached);
    expect(fetchCalls).toBe(0);
  });

  test("cache miss writes cache after fetch", async () => {
    const out = await runStatusline({
      fetch: makeMockFetch({ dispatchedHandoffs: 3, pendingPermissions: 0, doneInLastHour: 12 }),
    });
    expect(out).toBe("◌ penumbra  3 dispatched  12 done");
    const cached = await Bun.file(CACHE_PATH).text();
    expect(cached).toContain('"line":"◌ penumbra  3 dispatched  12 done"');
  });

  test("daemon offline returns graceful fallback", async () => {
    const out = await runStatusline({ fetch: makeMockFetch("offline") });
    expect(out).toBe("◑ penumbra  daemon offline");
  });

  test("glyph priority — pending permission wins over dispatched", async () => {
    const out = await runStatusline({
      fetch: makeMockFetch({ dispatchedHandoffs: 3, pendingPermissions: 1, doneInLastHour: 12 }),
    });
    expect(out).toBe("◐ penumbra  1 awaiting  3 dispatched  12 done");
  });

  test("idle state shows no counts", async () => {
    const out = await runStatusline({
      fetch: makeMockFetch({ dispatchedHandoffs: 0, pendingPermissions: 0, doneInLastHour: 0 }),
    });
    expect(out).toBe("● penumbra  idle");
  });
});
