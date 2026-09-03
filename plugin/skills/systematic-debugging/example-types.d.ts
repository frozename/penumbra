declare module "~/threads/thread-manager" {
  import type { LaceEvent } from "~/threads/types";

  export type ThreadManager = {
    getEvents(threadId: string): LaceEvent[];
  };
}

declare module "~/threads/types" {
  export type LaceEventType = string;
  export type LaceEvent = {
    type: LaceEventType;
    data?: unknown;
  };
}
