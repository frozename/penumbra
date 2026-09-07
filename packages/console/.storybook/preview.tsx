import type { Preview } from "@storybook/react";

import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import "../src/themes/tokens.css";
import "../src/themes/colors_and_type.css";
import "../src/themes/app.css";
import { useMissionStore } from "../src/modules/mission/store";
import { useDaemonStore } from "../src/stores/daemon-store";

useDaemonStore.setState({ baseUrl: "/api", token: "", health: "ok", lastHealthAt: 0 });

interface QuerySeed {
  key: QueryKey;
  data: unknown;
}

declare module "@storybook/react" {
  interface Parameters {
    queryCache?: QuerySeed[];
    missionStore?: Partial<{ tailFilter: string | null; pausedTail: boolean }>;
    daemonStore?: Partial<{
      baseUrl: string;
      token: string;
      health: "ok" | "down" | "unknown";
      lastHealthAt: number | null;
    }>;
    initialRoute?: string;
  }
}

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: "sirius",
      values: [
        { name: "sirius", value: "var(--color-bg)" },
        { name: "surface", value: "var(--color-surface)" },
      ],
    },
  },
  decorators: [
    (Story, ctx) => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
            refetchOnMount: false,
          },
        },
      });

      for (const seed of ctx.parameters.queryCache ?? []) {
        queryClient.setQueryData(seed.key, seed.data);
      }

      useMissionStore.setState({
        tailFilter: null,
        pausedTail: false,
        ...ctx.parameters.missionStore,
      });

      useDaemonStore.setState({
        baseUrl: "/api",
        token: "",
        health: "ok",
        lastHealthAt: 0,
        ...ctx.parameters.daemonStore,
      });

      const initialRoute = ctx.parameters.initialRoute ?? "/mission";

      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialRoute]}>
            <div data-theme="sirius" style={{ padding: 24, minWidth: 420 }}>
              <Story />
            </div>
          </MemoryRouter>
        </QueryClientProvider>
      );
    },
  ],
};

export default preview;
