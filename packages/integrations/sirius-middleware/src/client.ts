import type { T0EventInput } from "@penumbra/core";

export interface IPenumbraDaemonClient {
  observe(event: T0EventInput): Promise<void>;
}

export class PenumbraDaemonNoopClient implements IPenumbraDaemonClient {
  async observe(_event: T0EventInput): Promise<void> {}
}
