import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeApiReader } from "../../src/usage-readers/opencode-api-reader.js";

function makeAccountDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-api-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE account (
      id text PRIMARY KEY,
      email text NOT NULL,
      url text NOT NULL,
      access_token text NOT NULL,
      refresh_token text NOT NULL,
      token_expiry integer,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    CREATE TABLE account_state (
      id integer PRIMARY KEY NOT NULL,
      active_account_id text,
      active_org_id text
    );
  `);
  return { db, path };
}

describe("OpenCodeApiReader", () => {
  it("fetches active console config with bearer token and emits server usage snapshots", async () => {
    const { db, path } = makeAccountDb();
    db.prepare("INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "acct-1",
      "user@example.com",
      "https://console.opencode.ai",
      "access-token-1",
      "refresh-token-1",
      Date.now() + 60_000,
      1,
      1,
    );
    db.prepare("INSERT INTO account_state VALUES (?, ?, ?)").run(1, "acct-1", "org-1");
    db.close();

    const calls: Request[] = [];
    const reader = new OpenCodeApiReader({
      dbPath: path,
      fetch: async (input, init) => {
        const req = new Request(input, init);
        calls.push(req);
        return new Response(
          JSON.stringify({
            config: {
              providers: {
                "opencode-go": {
                  usage: {
                    five_hour: { used: 6, limit: 12, resets_at: 1777421548 },
                    seven_day: { used: 3, limit: 30, resets_at: 1777421549 },
                    thirty_day: { used: 1, limit: 60, resets_at: 1777421550 },
                  },
                },
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    const result = await reader.read(null);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://console.opencode.ai/api/config");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-token-1");
    expect(calls[0]?.headers.get("x-org-id")).toBe("org-1");
    expect(result.usage_deltas).toHaveLength(0);
    expect(result.rate_limit_snapshots).toHaveLength(3);
    expect(result.rate_limit_snapshots.find((s) => s.window_label === "five_hour")?.used_pct).toBe(
      50,
    );
    expect(result.rate_limit_snapshots.find((s) => s.window_label === "seven_day")?.used_pct).toBe(
      10,
    );
    expect(
      result.rate_limit_snapshots.find((s) => s.window_label === "thirty_day")?.used_pct,
    ).toBeCloseTo(1.6667, 3);
  });

  it("returns no snapshots when the OpenCode account database has no active account", async () => {
    const { db, path } = makeAccountDb();
    db.close();
    const reader = new OpenCodeApiReader({
      dbPath: path,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    const result = await reader.read(null);

    expect(result.usage_deltas).toHaveLength(0);
    expect(result.rate_limit_snapshots).toHaveLength(0);
  });

  it("returns no snapshots when the server-side usage endpoint is unavailable", async () => {
    const { db, path } = makeAccountDb();
    db.prepare("INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "acct-1",
      "user@example.com",
      "https://console.opencode.ai",
      "access-token-1",
      "refresh-token-1",
      Date.now() + 60_000,
      1,
      1,
    );
    db.prepare("INSERT INTO account_state VALUES (?, ?, ?)").run(1, "acct-1", "org-1");
    db.close();

    const reader = new OpenCodeApiReader({
      dbPath: path,
      fetch: async () => new Response("not found", { status: 404 }),
    });

    const result = await reader.read({ last_fetched_at: "2026-05-01T00:00:00.000Z" });

    expect(result.cursor).toEqual({ last_fetched_at: "2026-05-01T00:00:00.000Z" });
    expect(result.usage_deltas).toHaveLength(0);
    expect(result.rate_limit_snapshots).toHaveLength(0);
  });
});
