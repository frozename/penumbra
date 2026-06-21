import { create } from "zustand";

import { loadPenumbraConfig } from "../api/config.js";

export type DaemonHealth = "unknown" | "ok" | "down";

export interface DaemonStoreState {
  baseUrl: string;
  token: string;
  bootError: Error | null;
  health: DaemonHealth;
  lastHealthAt: number | null;
  setHealth: (health: DaemonHealth, checkedAt: number) => void;
}

export const useDaemonStore = create<DaemonStoreState>((set) => {
  try {
    const cfg = loadPenumbraConfig();
    return {
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      bootError: null,
      health: "unknown",
      lastHealthAt: null,
      setHealth: (health, checkedAt): void => {
        set({ health, lastHealthAt: checkedAt });
      },
    };
  } catch (error) {
    return {
      baseUrl: "",
      token: "",
      bootError: error instanceof Error ? error : new Error("Failed to load daemon config"),
      health: "unknown",
      lastHealthAt: null,
      setHealth: (health, checkedAt): void => {
        set({ health, lastHealthAt: checkedAt });
      },
    };
  }
});
