import type { Logger } from "../logger.js";
import type { WorkerDef, WorkerStatus, WorkerSupervisor } from "./interface.js";

interface Slot {
  def: WorkerDef;
  status: WorkerStatus;
  timer: Timer | null;
  inflight: boolean;
}

export class InProcessSupervisor implements WorkerSupervisor {
  private slots = new Map<string, Slot>();
  private log?: Pick<Logger, "warn">;

  constructor(opts?: { log?: Pick<Logger, "warn"> }) {
    this.log = opts?.log;
  }

  register(def: WorkerDef): void {
    this.slots.set(def.name, { def, status: "idle", timer: null, inflight: false });
  }

  async startAll(): Promise<void> {
    for (const slot of this.slots.values()) {
      await this.runTick(slot);
      slot.timer = setInterval(() => {
        void this.runTick(slot);
      }, slot.def.intervalMs);
    }
  }

  stopAll(): void {
    for (const slot of this.slots.values()) {
      if (slot.timer) clearInterval(slot.timer);
      slot.timer = null;
      slot.status = "stopped";
    }
  }

  status(name: string): WorkerStatus {
    return this.slots.get(name)?.status ?? "idle";
  }

  async runOnceNow(name: string): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`unknown worker ${name}`);
    await this.runTick(slot);
  }

  private async runTick(slot: Slot): Promise<void> {
    if (slot.inflight) return;
    slot.inflight = true;
    try {
      await slot.def.tick();
      if (slot.status !== "stopped") slot.status = "running";
    } catch (err) {
      if (slot.status !== "stopped") slot.status = "errored";
      this.log?.warn({ worker: slot.def.name, err: String(err) }, "worker tick failed");
    } finally {
      slot.inflight = false;
    }
  }
}
