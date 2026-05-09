import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "PENUMBRA_"],
  server: {
    port: 5176,
  },
});
