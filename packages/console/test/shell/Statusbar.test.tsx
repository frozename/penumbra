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
  test("renders default chips", () => {
    useDaemonStore.setState({
      baseUrl: "",
      token: "t",
      health: "unknown",
      lastHealthAt: null,
    });
    const { getByText } = render(<Statusbar />);

    expect(getByText((_, node) => node?.textContent === "daemon · 127.0.0.1:?")).toBeTruthy();
    expect(getByText("⎇ —")).toBeTruthy();
    expect(getByText("0 dispatched · 0 resolved")).toBeTruthy();
    expect(getByText("0 t0 in tail")).toBeTruthy();
    expect(getByText("sirius")).toBeTruthy();
    expect(getByText("penumbra · v0.8.2")).toBeTruthy();
  });

  test("renders provided values", () => {
    const { getByText } = render(
      <Statusbar
        port={51257}
        branch="main"
        dispatched={3}
        resolved={2}
        t0Count={17}
        theme="sirius"
        tz="America/Sao_Paulo"
        version="v1.2.3"
      />,
    );

    expect(getByText("daemon · 127.0.0.1:51257")).toBeTruthy();
    expect(getByText("⎇ main")).toBeTruthy();
    expect(getByText("3 dispatched · 2 resolved")).toBeTruthy();
    expect(getByText("17 t0 in tail")).toBeTruthy();
    expect(getByText("sirius")).toBeTruthy();
    expect(getByText("America/Sao_Paulo")).toBeTruthy();
    expect(getByText("penumbra · v1.2.3")).toBeTruthy();
  });

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
