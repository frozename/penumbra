import { Database } from 'bun:sqlite';
import { type Settings, type SettingsInput, SettingsDefaults } from './settings.js';
import { MachineId } from './identity/machine-id.js';
import { ProjectCache } from './identity/project-cache.js';
import { DbMeta } from './db/meta.js';
import { DEFAULT_REDACTION_RULES, RegexRedactor } from './redaction/regex.js';
import { T0Writer } from './writers/t0.js';
import { HandoffWriter } from './writers/handoff.js';
import { RecallReader } from './readers/recall.js';
import { HandoffReader } from './readers/handoff.js';
import { ChainReader } from './readers/chain.js';
import { InProcessSupervisor } from './supervisor/in-process.js';
import type { WorkerSupervisor } from './supervisor/interface.js';
import { PidRegistry } from './pid/registry.js';
import { systemClock, type Clock } from './utils/clock.js';
import { systemUuid, type Uuid } from './utils/uuid.js';
import type { Embedder } from './embedder/interface.js';
import { createLogger, type Logger } from './logger.js';
import { HandoffEventBus } from './events/handoff-events.js';
import { ConversationStreamBus } from './events/conversation-stream.js';
import { WorkerControlBus } from './events/worker-control.js';

export interface Watchdog {
  recordHeartbeat(worker_id: string): void;
  hasActiveWorker(timeoutMs: number): boolean;
  tick(): Promise<void>;
}

export interface Services {
  settings: Settings;
  storageRoot: string;
  db: Database;
  dbMeta: DbMeta;
  machineId: MachineId;
  projectCache: ProjectCache;
  redactor: RegexRedactor;
  t0Writer: T0Writer;
  handoffWriter: HandoffWriter;
  recallReader: RecallReader;
  handoffReader: HandoffReader;
  chainReader: ChainReader;
  handoffEvents: HandoffEventBus;
  conversationStream: ConversationStreamBus;
  workerControl: WorkerControlBus;
  watchdog: Watchdog;
  supervisor: WorkerSupervisor;
  pidRegistry: PidRegistry;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  log: Logger;
}

export interface BuildServicesOpts {
  env: NodeJS.ProcessEnv;
  input: SettingsInput;
  storageRoot: string;
  db: Database;
  embedder: Embedder;
  clock?: Clock;
  uuid?: Uuid;
  softPidCap?: number;
  hardPidCap?: number;
}

export function buildServices(opts: BuildServicesOpts): Services {
  const settings = SettingsDefaults.build({ env: opts.env, input: opts.input });
  const clock = opts.clock ?? systemClock;
  const uuid = opts.uuid ?? systemUuid;
  const machineId = new MachineId({ storageRoot: opts.storageRoot, uuid });
  const handoffEvents = new HandoffEventBus();
  const conversationStream = new ConversationStreamBus();
  const workerControl = new WorkerControlBus();
  const watchdog: Watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => false,
    tick: async () => {},
  };
  return {
    settings,
    storageRoot: opts.storageRoot,
    db: opts.db,
    dbMeta: new DbMeta(opts.db),
    machineId,
    projectCache: new ProjectCache({ db: opts.db, clock }),
    redactor: new RegexRedactor(DEFAULT_REDACTION_RULES),
    t0Writer: new T0Writer(opts.db),
    handoffWriter: new HandoffWriter({ db: opts.db, events: handoffEvents }),
    recallReader: new RecallReader({ db: opts.db, embedder: opts.embedder }),
    handoffReader: new HandoffReader({ db: opts.db }),
    chainReader: new ChainReader(opts.db),
    handoffEvents,
    conversationStream,
    workerControl,
    watchdog,
    supervisor: new InProcessSupervisor(),
    pidRegistry: new PidRegistry({
      softCap: opts.softPidCap ?? 8,
      hardCap: opts.hardPidCap ?? 16,
    }),
    embedder: opts.embedder,
    clock,
    uuid,
    log: createLogger({ component: 'penumbra' }),
  };
}
