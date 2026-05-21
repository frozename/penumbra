import { expect, test, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec, WorkerTokenStore } from '@penumbra/core';
import {
  runStaleWorkerTokensSweep,
  startStaleWorkerTokensSweeper,
  DEFAULT_STALE_WINDOW_MS,
  DEFAULT_INTERVAL_MS,
} from '../../src/sweepers/stale-worker-tokens.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function setupDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test('runStaleWorkerTokensSweep: token with last_seen_at older than window is revoked', () => {
  const db = setupDb();
  const store = new WorkerTokenStore(db);
  const t = 1_000_000;
  const { token_hash } = store.issue({ worker_id: 'W-A' }, t);

  // Manually backdate last_seen_at
  db.run("UPDATE worker_tokens SET last_seen_at = ? WHERE token_hash = ?", [t, token_hash]);

  const staleWindowMs = 24 * 60 * 60 * 1000;
  const nowMs = t + staleWindowMs + 1000; // 24h + 1s

  const result = runStaleWorkerTokensSweep({ db, staleWindowMs }, () => new Date(nowMs));
  
  expect(result.revokedCount).toBe(1);

  const row = db.query<{ revoked_at: number | null }, [string]> ("SELECT revoked_at FROM worker_tokens WHERE token_hash = ?").get(token_hash);
  
  expect(row).not.toBeNull();
  expect(row!.revoked_at).toBe(nowMs);
});

test('runStaleWorkerTokensSweep: token with recent last_seen_at is untouched', () => {
  const db = setupDb();
  const store = new WorkerTokenStore(db);
  const t = 1_000_000;
  const { token_hash } = store.issue({ worker_id: 'W-B' }, t);

  const staleWindowMs = 24 * 60 * 60 * 1000;
  const nowMs = t + 2 * 60 * 60 * 1000; // 2h

  // Update last_seen_at to slightly after issue to simulate activity
  db.run("UPDATE worker_tokens SET last_seen_at = ? WHERE token_hash = ?", [t + 3600_000, token_hash]);

  const result = runStaleWorkerTokensSweep({ db, staleWindowMs }, () => new Date(nowMs));
  
  expect(result.revokedCount).toBe(0);

  const row = db.query<{ revoked_at: number | null }, [string]> ("SELECT revoked_at FROM worker_tokens WHERE token_hash = ?").get(token_hash);
  
  expect(row).not.toBeNull();
  expect(row!.revoked_at).toBeNull();
});

test('runStaleWorkerTokensSweep: already-revoked tokens are not re-revoked', () => {
  const db = setupDb();
  const store = new WorkerTokenStore(db);
  const t1 = 1_000_000;
  const { token_hash } = store.issue({ worker_id: 'W-C' }, t1);

  // Explicitly revoke
  db.run("UPDATE worker_tokens SET revoked_at = ? WHERE token_hash = ?", [t1, token_hash]);

  const staleWindowMs = 24 * 60 * 60 * 1000;
  const nowMs = t1 + staleWindowMs + 1000;

  const result = runStaleWorkerTokensSweep({ db, staleWindowMs }, () => new Date(nowMs));
  
  expect(result.revokedCount).toBe(0);

  const row = db.query<{ revoked_at: number | null }, [string]> ("SELECT revoked_at FROM worker_tokens WHERE token_hash = ?").get(token_hash);
  
  expect(row).not.toBeNull();
  expect(row!.revoked_at).toBe(t1); // Remains t1
});

test('runStaleWorkerTokensSweep: revocation is consistent across mixed states', () => {
  const db = setupDb();
  const store = new WorkerTokenStore(db);
  const t = 1_000_000;
  
  // A: stale, active
  const tA = store.issue({ worker_id: 'W-A' }, t).token_hash;
  db.run("UPDATE worker_tokens SET last_seen_at = ? WHERE token_hash = ?", [t, tA]);

  // B: fresh, active
  const tB = store.issue({ worker_id: 'W-B' }, t).token_hash;
  db.run("UPDATE worker_tokens SET last_seen_at = ? WHERE token_hash = ?", [t + 23 * 3600 * 1000, tB]);

  // C: already revoked
  const tC = store.issue({ worker_id: 'W-C' }, t).token_hash;
  db.run("UPDATE worker_tokens SET last_seen_at = ?, revoked_at = ? WHERE token_hash = ?", [t, t, tC]);

  const staleWindowMs = 24 * 60 * 60 * 1000;
  const nowMs = t + staleWindowMs + 1000;

  const result = runStaleWorkerTokensSweep({ db, staleWindowMs }, () => new Date(nowMs));
  
  expect(result.revokedCount).toBe(1);

  const nullCount = db.query<{ c: number }, []> ("SELECT COUNT(*) as c FROM worker_tokens WHERE revoked_at IS NULL").get()?.c;
  const notNullCount = db.query<{ c: number }, []> ("SELECT COUNT(*) as c FROM worker_tokens WHERE revoked_at IS NOT NULL").get()?.c;
  
  expect(nullCount).toBe(1); // Only B is active
  expect(notNullCount).toBe(2); // A (newly revoked) + C (already revoked)
});

test('startStaleWorkerTokensSweeper returns a stop function that clears the interval', () => {
  const db = setupDb();
  const logWarn = mock(() => {});
  
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  
  let registeredCb: Function | null = null;
  let timerId: any = null;
  
  global.setInterval = ((cb: Function, ms: number) => {
    registeredCb = cb;
    timerId = { unref: mock(() => {}) };
    return timerId;
  }) as any;
  
  global.clearInterval = mock((id: any) => {
    expect(id).toBe(timerId);
  }) as any;
  
  try {
    const stop = startStaleWorkerTokensSweeper(
      { db, log: { warn: logWarn } as any, staleWindowMs: DEFAULT_STALE_WINDOW_MS },
      DEFAULT_INTERVAL_MS,
      () => new Date()
    );
    
    expect(registeredCb).not.toBeNull();
    expect(timerId.unref).toHaveBeenCalled();
    
    stop();
    
    expect(global.clearInterval).toHaveBeenCalledWith(timerId);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
