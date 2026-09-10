import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";

import { ApprovalsView } from "./modules/approvals";
import { HandoffDetail, HandoffsView } from "./modules/handoffs";
import { MODULES, type ModuleSpec } from "./modules/manifest";
import { MissionControl } from "./modules/mission";
import { RegistrarDetail, RegistrarList } from "./modules/registrar";
import { SessionsView } from "./modules/sessions";
import { Shell } from "./shell/Shell";

function NotFound(): JSX.Element {
  return <div className="surface-stub">404 — no such view.</div>;
}

function moduleElement(m: ModuleSpec): JSX.Element | null {
  if (m.id === "mission") {
    return <MissionControl />;
  }
  if (m.id === "approvals") {
    return <ApprovalsView />;
  }
  if (m.id === "sessions") {
    return <SessionsView />;
  }

  return null;
}

function moduleRoutes(m: ModuleSpec): RouteObject[] {
  if (m.id === "registrar") {
    return [
      { path: m.id, element: <RegistrarList /> },
      { path: `${m.id}/:registrarId`, element: <RegistrarDetail /> },
    ];
  }
  if (m.id === "handoffs") {
    return [
      { path: m.id, element: <HandoffsView /> },
      { path: `${m.id}/:handoffId`, element: <HandoffDetail /> },
    ];
  }
  return [{ path: m.id, element: moduleElement(m) }];
}

export function buildRoutes(modules: readonly ModuleSpec[] = MODULES): RouteObject[] {
  const firstAvailable = modules.find((m) => m.available);

  return [
    {
      path: "/",
      element: <Shell />,
      children: [
        {
          index: true,
          element: <Navigate to={`/${firstAvailable?.id ?? MODULES[0].id}`} replace />,
        },
        ...modules.filter((m) => m.available).flatMap(moduleRoutes),
        { path: "*", element: <NotFound /> },
      ],
    },
  ];
}

export const routes: RouteObject[] = buildRoutes();

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter(routes);
