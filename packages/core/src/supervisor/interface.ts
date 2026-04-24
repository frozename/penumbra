export type WorkerStatus = 'idle' | 'running' | 'stopped' | 'errored';

export interface WorkerDef {
  name: string;
  intervalMs: number;
  tick: () => Promise<void>;
}

export interface WorkerSupervisor {
  register(def: WorkerDef): void;
  startAll(): Promise<void>;
  stopAll(): void;
  status(name: string): WorkerStatus;
  runOnceNow(name: string): Promise<void>;
}
