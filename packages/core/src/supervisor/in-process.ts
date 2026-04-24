import type { WorkerDef, WorkerStatus, WorkerSupervisor } from './interface.js';

interface Slot {
  def: WorkerDef;
  status: WorkerStatus;
  timer: Timer | null;
}

export class InProcessSupervisor implements WorkerSupervisor {
  private slots = new Map<string, Slot>();

  register(def: WorkerDef): void {
    this.slots.set(def.name, { def, status: 'idle', timer: null });
  }

  async startAll(): Promise<void> {
    for (const slot of this.slots.values()) {
      await this.runTick(slot);
      slot.timer = setInterval(() => { void this.runTick(slot); }, slot.def.intervalMs);
      slot.status = 'running';
    }
  }

  stopAll(): void {
    for (const slot of this.slots.values()) {
      if (slot.timer) clearInterval(slot.timer);
      slot.timer = null;
      slot.status = 'stopped';
    }
  }

  status(name: string): WorkerStatus {
    return this.slots.get(name)?.status ?? 'idle';
  }

  async runOnceNow(name: string): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`unknown worker ${name}`);
    await this.runTick(slot);
  }

  private async runTick(slot: Slot): Promise<void> {
    try {
      await slot.def.tick();
      if (slot.status !== 'stopped') slot.status = 'running';
    } catch {
      slot.status = 'errored';
    }
  }
}
