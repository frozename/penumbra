import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Provide sane dev defaults so `bun run dev` works without an explicit env.
// E2E and other callers set these explicitly and take precedence.
if (!process.env.PENUMBRA_DAEMON_URL) {
  process.env.PENUMBRA_DAEMON_URL = "http://127.0.0.1:51257";
}
if (!process.env.PENUMBRA_TOKEN) {
  try {
    process.env.PENUMBRA_TOKEN = readFileSync(
      join(homedir(), ".penumbra", "token"),
      "utf8",
    ).trim();
  } catch {
    // No token file — leave empty; loadPenumbraConfig will surface the error.
  }
}

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "PENUMBRA_"],
  server: {
    port: 5176,
  },
});
