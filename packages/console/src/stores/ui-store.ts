import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { type ModuleId, MODULES } from "../modules/manifest.js";

export type ActiveModule = ModuleId;

export interface UIState {
  activeModule: ActiveModule;
  explorerCollapsed: boolean;
  setActiveModule: (m: ActiveModule) => void;
  setExplorerCollapsed: (v: boolean) => void;
  toggleExplorerCollapsed: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      activeModule: MODULES[0].id,
      explorerCollapsed: false,
      setActiveModule: (m): void => {
        set({ activeModule: m });
      },
      setExplorerCollapsed: (v): void => {
        set({ explorerCollapsed: v });
      },
      toggleExplorerCollapsed: (): void => {
        set({ explorerCollapsed: !get().explorerCollapsed });
      },
    }),
    {
      name: "penumbra-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ activeModule, explorerCollapsed }) => ({
        activeModule,
        explorerCollapsed,
      }),
    },
  ),
);
