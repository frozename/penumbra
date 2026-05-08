import "../setup";
import { beforeEach, describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { Statusbar } from "../../src/shell/Statusbar";
import { useDaemonStore } from "../../src/stores/daemon-store";

beforeEach(() => {
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "t",
    health: "unknown",
    lastHealthAt: null,
  });
});

describe("Statusbar", () => {
  test("daemon health dot reflects store health", () => {
    const { container, rerender } = render(<Statusbar />);

    const getDot = () => container.querySelector(".dot") as HTMLElement | null;

    expect(getDot()?.className).toBe("dot dot-warn");

    act(() => {
      useDaemonStore.setState({
        baseUrl: "http://127.0.0.1:51257",
        token: "t",
        health: "ok",
        lastHealthAt: 0,
      });
      rerender(<Statusbar />);
    });
    expect(getDot()?.className).toBe("dot dot-ok");

    act(() => {
      useDaemonStore.setState({
        baseUrl: "http://127.0.0.1:51257",
        token: "t",
        health: "down",
        lastHealthAt: 0,
      });
      rerender(<Statusbar />);
    });
    expect(getDot()?.className).toBe("dot dot-err");

    act(() => {
      useDaemonStore.setState({
        baseUrl: "http://127.0.0.1:51257",
        token: "t",
        health: "unknown",
        lastHealthAt: 0,
      });
      rerender(<Statusbar />);
    });
    expect(getDot()?.className).toBe("dot dot-warn");
  });
});
