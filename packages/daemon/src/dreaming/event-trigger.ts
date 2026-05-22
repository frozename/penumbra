import type { Database } from 'bun:sqlite';
import type { DreamConfig } from './config.js';
import { runDreamCycle } from './cycle.js';

export interface IdleSignalDeps {
  mutexHeld: boolean;
  log: { warn: (msg: string) => void };
}

let inFlightTrigger = false;
let lastTriggerMs = 0;

export async function handleIdleSignal(db: Database, config: DreamConfig, deps: IdleSignalDeps): Promise<void> {
  if (deps.mutexHeld || inFlightTrigger) {
    deps.log.warn('dream.trigger.dropped: mutex held');
    return;
  }
  const now = Date.now();
  if (now - lastTriggerMs < config.triggerCooldownMinutes * 60_000) {
    deps.log.warn('dream.trigger.dropped: cooldown active');
    return;
  }
  
  inFlightTrigger = true;
  try {
    lastTriggerMs = now;
    await runDreamCycle(db, config);
  } finally {
    inFlightTrigger = false;
  }
}
