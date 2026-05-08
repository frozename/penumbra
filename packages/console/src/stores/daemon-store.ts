import { create } from "zustand";
import { loadPenumbraConfig } from "../api/config";

export type DaemonHealth = "unknown" | "ok" | "down";

export interface DaemonState {
  baseUrl: string;
  token: string;
  health: DaemonHealth;
  lastHealthAt: number | null;
  setHealth: (h: DaemonHealth, at: number) => void;
  init: (loader?: () => { baseUrl: string; token: string }) => void;
}

export const useDaemonStore = create<DaemonState>((set, get) => ({
  baseUrl: "",
  token: "",
  health: "unknown",
  lastHealthAt: null,
  setHealth: (h, at) => set({ health: h, lastHealthAt: at }),
  init: (loader) => {
    if (get().baseUrl !== "") return;
    const cfg = (loader ?? loadPenumbraConfig)();
    set({ baseUrl: cfg.baseUrl, token: cfg.token });
  },
}));
