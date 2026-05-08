import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { MODULES, type ModuleId } from "../modules/manifest";

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
      setActiveModule: (m) => set({ activeModule: m }),
      setExplorerCollapsed: (v) => set({ explorerCollapsed: v }),
      toggleExplorerCollapsed: () =>
        set({ explorerCollapsed: !get().explorerCollapsed }),
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
