import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { handleIdleSignal } from '../../src/dreaming/event-trigger.js';
import { loadDreamConfigFromEnv } from '../../src/dreaming/config.js';
import * as cycle from '../../src/dreaming/cycle.js';

describe('dreaming/event-trigger', () => {
  let db: Database;
  
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE dream_cycles(
        cycle_id TEXT PRIMARY KEY,
        started_at INTEGER,
        trigger TEXT,
        budget_usd_cap REAL,
        outcome TEXT,
        phases_run TEXT,
        bail_reason TEXT,
        ended_at INTEGER,
        last_phase_completed TEXT,
        llm_spent_usd REAL DEFAULT 0,
        embedding_spent_usd REAL DEFAULT 0,
        research_spent_usd REAL DEFAULT 0
      );
      CREATE TABLE t1_rollups (rollup_id TEXT, t2_promoted_at TEXT, claimed_at TEXT, started_at TEXT, claimed_by_cycle TEXT, first_prompt_excerpt TEXT);
      CREATE TABLE memory_links (src_id TEXT, dst_id TEXT, link_type TEXT, retired_at TEXT, weight REAL, minted_at INTEGER, minted_by_cycle TEXT, link_id TEXT);
      CREATE TABLE dream_actions (action_id TEXT, phase TEXT, status TEXT, target_ids TEXT, payload_json TEXT, decided_at INTEGER, reverted_by TEXT, expires_at INTEGER, action_type TEXT, cycle_id TEXT, confidence REAL);
      CREATE TABLE t2_memories(
        rowid INTEGER PRIMARY KEY,
        memory_id TEXT,
        user_id TEXT,
        kind TEXT,
        window_start TEXT,
        window_end TEXT,
        title TEXT,
        body TEXT,
        created_at TEXT,
        updated_at TEXT,
        retired_at INTEGER
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('drops when mutexHeld is true', async () => {
    const config = loadDreamConfigFromEnv();
    const log = { warn: () => {} };
    await handleIdleSignal(db, config, { mutexHeld: true, log });
    const count = db.prepare('SELECT COUNT(*) as c FROM dream_cycles').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('10 concurrent calls produce exactly 1 cycle', async () => {
    const config = loadDreamConfigFromEnv();
    config.triggerCooldownMinutes = 0; // Disable cooldown for the test
    const log = { warn: () => {} };
    
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(handleIdleSignal(db, config, { mutexHeld: false, log }));
    }
    await Promise.all(promises);
    
    const count = db.prepare('SELECT COUNT(*) as c FROM dream_cycles').get() as { c: number };
    expect(count.c).toBe(1);
  });
});
