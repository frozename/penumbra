import { expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.js";
import { runStart } from "../src/commands/start.js";
import { runStop } from "../src/commands/stop.js";
import { runStatus } from "../src/commands/status.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

let dir = "";
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-status-"));
  await runInit({ storageRoot: dir, uuid: () => "tok" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('status returns "running" when daemon is up', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    const r = await runStatus({ storageRoot: dir });
    expect(r.status).toBe("running");
    expect(r.port).toBe(handle.port);
    expect(r.embedder).toBeDefined();
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});

test('status returns "stale" when daemon lacks current dispatch event route', async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/metrics") {
        return Response.json({
          embedder: { name: "test", dim: 384 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    writeFileSync(join(dir, "pid"), `${process.pid}\n`);
    writeFileSync(join(dir, "port"), `${srv.port}\n`);
    writeFileSync(join(dir, "token"), "tok\n");

    const r = await runStatus({ storageRoot: dir });
    expect(r.status).toBe("stale");
    expect(r.reason).toBe("missing_dispatch_events_route");
  } finally {
    srv.stop(true);
  }
});

test('status returns "stopped" when pid/port files are absent', async () => {
  const r = await runStatus({ storageRoot: dir });
  expect(r.status).toBe("stopped");
});
