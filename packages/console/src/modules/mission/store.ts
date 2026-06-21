import { create } from "zustand";

export interface MissionStoreState {
  /** Free-text filter applied to the t0 tail (Phase 5.5). null = no filter. */
  tailFilter: string | null;
  /** When true, the t0 tail stops appending new events but keeps existing rows. */
  pausedTail: boolean;
}

export interface MissionStoreActions {
  setTailFilter: (filter: string | null) => void;
  setPausedTail: (paused: boolean) => void;
}

export const useMissionStore = create<MissionStoreState & MissionStoreActions>((set) => ({
  tailFilter: null,
  pausedTail: false,
  setTailFilter: (tailFilter): void => {
    set({ tailFilter });
  },
  setPausedTail: (pausedTail): void => {
    set({ pausedTail });
  },
}));
