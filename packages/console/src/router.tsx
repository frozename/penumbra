import { Navigate, createBrowserRouter, type RouteObject } from "react-router-dom";
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

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/mission" replace /> },
      { path: "mission", element: <MissionStub /> },
      { path: "chains", element: <DeferredViewStub view="Chains" /> },
      { path: "tasks", element: <DeferredViewStub view="Tasks" /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter(routes);
