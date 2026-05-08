import { beforeEach, describe, expect, test } from "bun:test";
import { useUIStore } from "../../src/stores/ui-store";

describe("useUIStore", () => {
  beforeEach(() => {
    useUIStore.setState({
      activeModule: "mission",
      explorerCollapsed: false,
    });
    localStorage.clear();
  });

  test("defaults to mission with explorer expanded", () => {
    const state = useUIStore.getState();
    expect(state.activeModule).toBe("mission");
    expect(state.explorerCollapsed).toBe(false);
  });

  test("setActiveModule updates the active module", () => {
    useUIStore.getState().setActiveModule("chains");
    expect(useUIStore.getState().activeModule).toBe("chains");
  });

  test("setExplorerCollapsed and toggleExplorerCollapsed update the collapse state", () => {
    useUIStore.getState().setExplorerCollapsed(true);
    expect(useUIStore.getState().explorerCollapsed).toBe(true);

    useUIStore.getState().toggleExplorerCollapsed();
    expect(useUIStore.getState().explorerCollapsed).toBe(false);
  });

  test("persists active module and explorer collapse state", async () => {
    useUIStore.getState().setActiveModule("tasks");
    expect(localStorage.getItem("penumbra-ui")).toContain("tasks");

    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().activeModule).toBe("tasks");
    expect(useUIStore.getState().explorerCollapsed).toBe(false);
  });
});
