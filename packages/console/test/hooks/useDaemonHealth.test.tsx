import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import type { DaemonClient } from "../../src/api/client";
import { useDaemonHealth } from "../../src/hooks/useDaemonHealth";
import { useDaemonStore } from "../../src/stores/daemon-store";

beforeEach(() => {
  useDaemonStore.setState({
    baseUrl: "",
    token: "",
    health: "unknown",
    lastHealthAt: null,
  });
});

afterEach(() => {
  useDaemonStore.setState({
    baseUrl: "",
    token: "",
    health: "unknown",
    lastHealthAt: null,
  });
});

describe("useDaemonHealth", () => {
  test("polls immediately and updates store on success", async () => {
    const health = mock(async () => ({ status: "ok" as const }));
    const client = { health } as unknown as DaemonClient;

    const { unmount } = renderHook(() => useDaemonHealth({ client, intervalMs: 1_000 }));

    await waitFor(() => {
      expect(health).toHaveBeenCalledTimes(1);
      expect(useDaemonStore.getState().health).toBe("ok");
    });
    unmount();
  });

  test("polls again after interval", async () => {
    const health = mock(async () => ({ status: "ok" as const }));
    const client = { health } as unknown as DaemonClient;

    const { unmount } = renderHook(() => useDaemonHealth({ client, intervalMs: 20 }));

    await waitFor(() => expect(health).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(health.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  test("sets health down on error", async () => {
    const health = mock(async () => {
      throw new Error("offline");
    });
    const client = { health } as unknown as DaemonClient;

    const { unmount } = renderHook(() => useDaemonHealth({ client, intervalMs: 1_000 }));

    await waitFor(() => {
      expect(health).toHaveBeenCalledTimes(1);
      expect(useDaemonStore.getState().health).toBe("down");
    });
    unmount();
  });

  test("cleans up the interval on unmount", async () => {
    const health = mock(async () => ({ status: "ok" as const }));
    const client = { health } as unknown as DaemonClient;

    const { unmount } = renderHook(() =>
      useDaemonHealth({ client, intervalMs: 20 }),
    );

    await waitFor(() => expect(health).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(health.mock.calls.length).toBe(1);
  });
});
