import { beforeEach, describe, expect, test } from "bun:test";

import { useDaemonStore } from "@src/stores/daemon-store.js";

describe("useDaemonStore", () => {
  beforeEach(() => {
    useDaemonStore.setState({
      baseUrl: "",
      token: "",
      bootError: null,
      health: "unknown",
      lastHealthAt: null,
    });
  });

  test("default state is empty + unknown", () => {
    const s = useDaemonStore.getState();
    expect(s.baseUrl).toBe("");
    expect(s.token).toBe("");
    expect(s.bootError).toBeNull();
    expect(s.health).toBe("unknown");
    expect(s.lastHealthAt).toBeNull();
  });

  test("setHealth updates health and timestamp", () => {
    useDaemonStore.getState().setHealth("ok", 12345);
    const s = useDaemonStore.getState();
    expect(s.health).toBe("ok");
    expect(s.lastHealthAt).toBe(12345);
  });
});
