import { Navigate, createBrowserRouter, type RouteObject } from "react-router-dom";
import { MODULES } from "./modules/manifest";
import { Shell } from "./shell/Shell";

function MissionStub(): JSX.Element {
  return <div className="surface-stub">Mission Control coming online…</div>;
}

function DeferredViewStub({ view }: { view: string }): JSX.Element {
  return <div className="surface-stub">{view} module — wired in P1.</div>;
}

function NotFound(): JSX.Element {
  return <div className="surface-stub">404 — no such view.</div>;
}

function moduleElement(m: (typeof MODULES)[number]): JSX.Element {
  if (m.id === "mission") {
    return <MissionStub />;
  }

  return <DeferredViewStub view={m.label} />;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to={`/${MODULES[0].id}`} replace /> },
      ...MODULES.map((m) => ({ path: m.id, element: moduleElement(m) })),
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter(routes);
