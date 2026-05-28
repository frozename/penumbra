import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemUuid, type Uuid } from "../utils/uuid.js";

export class MachineId {
  private cached: string | null = null;
  private readonly path: string;
  private readonly uuid: Uuid;

  constructor(opts: { storageRoot: string; uuid?: Uuid }) {
    this.path = join(opts.storageRoot, "machine-id");
    this.uuid = opts.uuid ?? systemUuid;
  }

  get(): string {
    if (this.cached) return this.cached;
    if (existsSync(this.path)) {
      this.cached = readFileSync(this.path, "utf8").trim();
      return this.cached;
    }
    const fresh = this.uuid();
    mkdirSync(join(this.path, ".."), { recursive: true });
    writeFileSync(this.path, fresh + "\n", { mode: 0o600 });
    this.cached = fresh;
    return fresh;
  }
}
