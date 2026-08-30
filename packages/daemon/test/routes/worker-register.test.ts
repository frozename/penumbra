import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@src/serve.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface RegisterSuccessBody {
  worker_id: string;
  worker_token: string;
}
interface RegisterErrorBody {
  error: { code: string };
}
interface WorkerTokenRow {
  worker_id: string;
  metadata_json: string | null;
  token_hash: string;
}
interface CountRow {
  n: number;
}

async function readSuccess(res: Response): Promise<RegisterSuccessBody> {
  return (await res.json()) as RegisterSuccessBody;
}
async function readError(res: Response): Promise<RegisterErrorBody> {
  return (await res.json()) as RegisterErrorBody;
}

function selectWorkerTokenRow(services: Services, tokenHash: string): WorkerTokenRow | null {
  return (
    services.db
      .query<
        WorkerTokenRow,
        [string]
      >("SELECT worker_id, metadata_json, token_hash FROM worker_tokens WHERE token_hash = ?")
      .get(tokenHash) ?? null
  );
}

function countWorkerTokens(services: Services, workerId: string): number {
  const row = services.db
    .query<CountRow, [string]>("SELECT COUNT(*) as n FROM worker_tokens WHERE worker_id = ?")
    .get(workerId);
  return row?.n ?? 0;
}

function totalWorkerTokens(services: Services): number {
  const row = services.db.query<CountRow, []>("SELECT COUNT(*) as n FROM worker_tokens").get();
  return row?.n ?? 0;
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/register-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-20T10:00:00Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `e-${String(++n)}`;
    })(),
  });
}

const SHARED_TOKEN = "shared-sec";

test("POST /worker/register with shared bearer returns 200 + worker_token", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A", metadata: { host: "mac-mini" } }),
    }),
  );

  expect(res.status).toBe(200);
  const body = await readSuccess(res);
  expect(body.worker_id).toBe("W-A");
  expect(typeof body.worker_token).toBe("string");
  expect(body.worker_token.length).toBeGreaterThan(10);

  const hash = createHash("sha256").update(body.worker_token).digest("hex");
  const row = selectWorkerTokenRow(services, hash);
  expect(row).not.toBeNull();
  expect(row?.worker_id).toBe("W-A");
  expect(row?.metadata_json).toBe(JSON.stringify({ host: "mac-mini" }));
});

test("POST /worker/register without metadata persists metadata_json NULL", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );

  expect(res.status).toBe(200);
  const body = await readSuccess(res);

  const hash = createHash("sha256").update(body.worker_token).digest("hex");
  const row = selectWorkerTokenRow(services, hash);
  expect(row).not.toBeNull();
  expect(row?.metadata_json).toBe(null);
});

test("POST /worker/register without Authorization returns 401", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );

  expect(res.status).toBe(401);
});

test("POST /worker/register with unknown bearer returns 401", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );

  expect(res.status).toBe(401);
  expect(totalWorkerTokens(services)).toBe(0);
});

test("POST /worker/register with a worker token returns 403 shared_bearer_required_for_registration", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res1 = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  const body1 = await readSuccess(res1);
  const workerToken = body1.worker_token;

  const res2 = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );

  expect(res2.status).toBe(403);
  const body2 = await readError(res2);
  expect(body2.error.code).toBe("shared_bearer_required_for_registration");
});

test("Two register calls for the same worker_id produce distinct tokens; both rows present", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const req = (id: string): Request =>
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: id }),
    });

  const res1 = await fetchHandler(req("W-A"));
  const body1 = await readSuccess(res1);

  const res2 = await fetchHandler(req("W-A"));
  const body2 = await readSuccess(res2);

  expect(body1.worker_token).not.toBe(body2.worker_token);
  expect(countWorkerTokens(services, "W-A")).toBe(2);
});

test("POST /worker/register with malformed JSON returns 400 invalid_json", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: "{{{not json}}}",
    }),
  );

  expect(res.status).toBe(400);
  const body = await readError(res);
  expect(body.error.code).toBe("invalid_json");
});

test("POST /worker/register with missing worker_id returns 400 validation_error", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: {} }),
    }),
  );

  expect(res.status).toBe(400);
  const body = await readError(res);
  expect(body.error.code).toBe("validation_error");
});

test("POST /worker/register with metadata > 4 KiB returns 400 metadata_too_large", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const huge = { blob: "x".repeat(5000) };
  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A", metadata: huge }),
    }),
  );

  expect(res.status).toBe(400);
  const body = await readError(res);
  expect(body.error.code).toBe("metadata_too_large");
  expect(countWorkerTokens(services, "W-A")).toBe(0);
});

test("metadata at exactly 4096 UTF-8 bytes succeeds", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  // {"blob":"<4085 x's>"} → 11 + 4085 = 4096 UTF-8 bytes (all ASCII).
  const meta = { blob: "x".repeat(4085) };
  expect(Buffer.byteLength(JSON.stringify(meta), "utf8")).toBe(4096);

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${SHARED_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: "W-boundary-ok", metadata: meta }),
    }),
  );

  expect(res.status).toBe(200);
  const body = await readSuccess(res);
  expect(body.worker_id).toBe("W-boundary-ok");
});

test("metadata at 4097 UTF-8 bytes returns 400 metadata_too_large", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  // {"blob":"<4086 x's>"} → 11 + 4086 = 4097 UTF-8 bytes.
  const meta = { blob: "x".repeat(4086) };
  expect(Buffer.byteLength(JSON.stringify(meta), "utf8")).toBe(4097);

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${SHARED_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: "W-boundary-fail", metadata: meta }),
    }),
  );

  expect(res.status).toBe(400);
  const body = await readError(res);
  expect(body.error.code).toBe("metadata_too_large");
});

test("metadata with multibyte characters is sized by UTF-8 bytes, not char count", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  // 2050 'é' chars × 2 UTF-8 bytes = 4100 + 11 wrapper = 4111 bytes → 400.
  // But JSON.stringify(...).length = 11 + 2050 = 2061 ≤ 4096, so old .length check would pass.
  const meta = { blob: "é".repeat(2050) };
  const serialized = JSON.stringify(meta);
  expect(serialized.length).toBeLessThanOrEqual(4096); // old check would allow this
  expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(4096); // byte check rejects it

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${SHARED_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: "W-multibyte-fail", metadata: meta }),
    }),
  );

  expect(res.status).toBe(400);
  const body = await readError(res);
  expect(body.error.code).toBe("metadata_too_large");
});

test("metadata of multibyte characters under the byte cap succeeds", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  // 2000 'é' chars × 2 UTF-8 bytes = 4000 + 11 wrapper = 4011 bytes ≤ 4096 → 200.
  const meta = { blob: "é".repeat(2000) };
  expect(Buffer.byteLength(JSON.stringify(meta), "utf8")).toBeLessThanOrEqual(4096);

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${SHARED_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: "W-multibyte-ok", metadata: meta }),
    }),
  );

  expect(res.status).toBe(200);
  const body = await readSuccess(res);
  expect(body.worker_id).toBe("W-multibyte-ok");
});

test("POST /worker/register with metadata at the 4 KiB boundary succeeds", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  // {"v":"<4000 x's>"} = 9 + 4000 = 4009 chars — well within 4096
  const boundaryMeta = { v: "x".repeat(4000) };
  expect(JSON.stringify(boundaryMeta).length).toBeLessThanOrEqual(4096);

  const res = await fetchHandler(
    new Request("http://x/worker/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-B", metadata: boundaryMeta }),
    }),
  );

  expect(res.status).toBe(200);
  const body = await readSuccess(res);
  expect(body.worker_id).toBe("W-B");
  expect(typeof body.worker_token).toBe("string");
});
