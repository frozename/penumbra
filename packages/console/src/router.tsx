import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";

import { MODULES } from "./modules/manifest";
import { MissionControl } from "./modules/mission";
import { RegistrarDetail, RegistrarList } from "./modules/registrar";
import { SessionsView } from "./modules/sessions";
import { Shell } from "./shell/Shell";

function DeferredViewStub({ view }: { view: string }): JSX.Element {
  return <div className="surface-stub">{view} module — wired in P1.</div>;
}

function NotFound(): JSX.Element {
  return <div className="surface-stub">404 — no such view.</div>;
}

function moduleElement(m: (typeof MODULES)[number]): JSX.Element {
  if (m.id === "mission") {
    return <MissionControl />;
  }
  if (m.id === "sessions") {
    return <SessionsView />;
  }

  return <DeferredViewStub view={m.label} />;
}

function moduleRoutes(m: (typeof MODULES)[number]): RouteObject[] {
  if (m.id === "registrar") {
    return [
      { path: m.id, element: <RegistrarList /> },
      { path: `${m.id}/:registrarId`, element: <RegistrarDetail /> },
    ];
  }
  return [{ path: m.id, element: moduleElement(m) }];
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to={`/${MODULES[0].id}`} replace /> },
      ...MODULES.flatMap(moduleRoutes),
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter(routes);
