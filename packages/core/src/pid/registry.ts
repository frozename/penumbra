export interface PidEntry {
  pid: number;
  name: string;
  startedAt: Date;
}

export interface PidRegistryOpts {
  softCap: number;
  hardCap: number;
}

export class PidRegistry {
  private entries: PidEntry[] = [];
  constructor(private readonly caps: PidRegistryOpts) {}

  register(e: PidEntry): string | null {
    if (this.entries.length >= this.caps.hardCap) {
      throw new Error(`PidRegistry hardCap=${String(this.caps.hardCap)} reached`);
    }
    this.entries.push(e);
    if (this.entries.length > this.caps.softCap) {
      return `over softCap=${String(this.caps.softCap)}, ${String(this.entries.length)} active`;
    }
    return null;
  }

  live(): PidEntry[] {
    return this.entries.filter((e) => isAlive(e.pid));
  }

  reap(): PidEntry[] {
    const dead: PidEntry[] = [];
    this.entries = this.entries.filter((e) => {
      if (isAlive(e.pid)) return true;
      dead.push(e);
      return false;
    });
    return dead;
  }

  unregister(pid: number): void {
    this.entries = this.entries.filter((e) => e.pid !== pid);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user — still alive.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}
