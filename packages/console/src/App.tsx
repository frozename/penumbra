import { useEffect, useMemo, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "./router";
import { useDaemonStore } from "./stores/daemon-store";

export function App() {
  const [bootError, setBootError] = useState<Error | null>(null);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
      }),
    [],
  );

  useEffect(() => {
    try {
      useDaemonStore.getState().loadConfig();
    } catch (e) {
      setBootError(e as Error);
    }
  }, []);

  if (bootError) {
    return (
      <div className="surface-stub" role="alert">
        <h1>Console failed to start</h1>
        <p>{bootError.message}</p>
        <p style={{ opacity: 0.7 }}>
          Check that <code>~/.penumbra/token</code> and the daemon URL are reachable.
        </p>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
