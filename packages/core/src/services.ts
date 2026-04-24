import { Database } from 'bun:sqlite';
import { type Settings, type SettingsInput, SettingsDefaults } from './settings.js';
import { MachineId } from './identity/machine-id.js';
import { ProjectCache } from './identity/project-cache.js';
import { DbMeta } from './db/meta.js';
import { DEFAULT_REDACTION_RULES, RegexRedactor } from './redaction/regex.js';
import { T0Writer } from './writers/t0.js';
import { RecallReader } from './readers/recall.js';
import { InProcessSupervisor } from './supervisor/in-process.js';
import { PidRegistry } from './pid/registry.js';
import { systemClock, type Clock } from './utils/clock.js';
import { systemUuid, type Uuid } from './utils/uuid.js';
import type { Embedder } from './embedder/interface.js';
import { createLogger, type Logger } from './logger.js';

export interface Services {
  settings: Settings;
  storageRoot: string;
  db: Database;
  dbMeta: DbMeta;
  machineId: MachineId;
  projectCache: ProjectCache;
  redactor: RegexRedactor;
  t0Writer: T0Writer;
  recallReader: RecallReader;
  supervisor: InProcessSupervisor;
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
  return {
    settings,
    storageRoot: opts.storageRoot,
    db: opts.db,
    dbMeta: new DbMeta(opts.db),
    machineId,
    projectCache: new ProjectCache({ db: opts.db, clock }),
    redactor: new RegexRedactor(DEFAULT_REDACTION_RULES),
    t0Writer: new T0Writer(opts.db),
    recallReader: new RecallReader({ db: opts.db, embedder: opts.embedder }),
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
