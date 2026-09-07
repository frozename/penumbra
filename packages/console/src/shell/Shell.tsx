import { Outlet } from "react-router-dom";

import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import { ToastProvider } from "../ui/Toast";
import { Explorer } from "./Explorer";
import { Rail } from "./Rail";
import { SessionInvalidBanner } from "./SessionInvalidBanner";
import { Statusbar } from "./Statusbar";
import { Titlebar } from "./Titlebar";

export function Shell(): JSX.Element {
  useDaemonHealth();

  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <SessionInvalidBanner />
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
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
