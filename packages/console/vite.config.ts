import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  const isServe = command === "serve";
  return {
    plugins: [react()],
    server: {
      port: 5176,
    },
    define: {
      __PENUMBRA_DEV_TOKEN__: JSON.stringify(
        isServe ? (process.env.PENUMBRA_TOKEN ?? "") : "",
      ),
      __PENUMBRA_DEV_DAEMON_URL__: JSON.stringify(
        isServe
          ? (process.env.PENUMBRA_DAEMON_URL ?? "http://127.0.0.1:51257")
          : "",
      ),
    },
  };
});
