import { Outlet } from "react-router-dom";
import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { Explorer } from "./Explorer";
import { Rail } from "./Rail";
import { Statusbar } from "./Statusbar";
import { Titlebar } from "./Titlebar";

export function Shell(): JSX.Element {
  useDaemonHealth();

  return (
    <div className="app">
      <Titlebar />
      <div className="main">
        <Rail />
        <Explorer />
        <section className="surface">
          <Outlet />
        </section>
      </div>
      <Statusbar />
    </div>
  );
}
