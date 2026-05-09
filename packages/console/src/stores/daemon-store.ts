import { create } from "zustand";
import { loadPenumbraConfig } from "../api/config";

export type DaemonHealth = "unknown" | "ok" | "down";

export interface DaemonStoreState {
  baseUrl: string;
  token: string;
  health: DaemonHealth;
  lastHealthAt: number | null;
  setHealth: (health: DaemonHealth, checkedAt: number) => void;
  loadConfig: (loader?: () => { baseUrl: string; token: string }) => void;
}

export const useDaemonStore = create<DaemonStoreState>((set, get) => ({
  baseUrl: "",
  token: "",
  health: "unknown",
  lastHealthAt: null,
  setHealth: (health, checkedAt) =>
    set({ health, lastHealthAt: checkedAt }),
  loadConfig: (loader) => {
    if (get().baseUrl !== "") return;
    const cfg = (loader ?? loadPenumbraConfig)();
    set({ baseUrl: cfg.baseUrl, token: cfg.token });
  },
}));
