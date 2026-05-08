import { beforeEach, describe, expect, test, mock } from "bun:test";
import { useDaemonStore } from "../../src/stores/daemon-store";

describe("useDaemonStore", () => {
  beforeEach(() => {
    useDaemonStore.setState({
      baseUrl: "",
      token: "",
      health: "unknown",
      lastHealthAt: null,
    });
  });

  test("default state is empty + unknown", () => {
    const s = useDaemonStore.getState();
    expect(s.baseUrl).toBe("");
    expect(s.token).toBe("");
    expect(s.health).toBe("unknown");
    expect(s.lastHealthAt).toBeNull();
  });

  test("setHealth updates health and timestamp", () => {
    useDaemonStore.getState().setHealth("ok", 12345);
    const s = useDaemonStore.getState();
    expect(s.health).toBe("ok");
    expect(s.lastHealthAt).toBe(12345);
  });

  test("init() populates baseUrl and token via injected loader", () => {
    const loader = mock(() => ({
      baseUrl: "http://127.0.0.1:51257",
      token: "tok-1",
    }));
    useDaemonStore.getState().init(loader);
    const s = useDaemonStore.getState();
    expect(s.baseUrl).toBe("http://127.0.0.1:51257");
    expect(s.token).toBe("tok-1");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("init() is idempotent — second call does not invoke loader", () => {
    const loader = mock(() => ({
      baseUrl: "http://127.0.0.1:51257",
      token: "tok-1",
    }));
    useDaemonStore.getState().init(loader);
    useDaemonStore.getState().init(loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
