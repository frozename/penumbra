// Polyfill Reflect metadata API required by NestJS decorators.
// Must be loaded before any @nestjs/common import.
import "reflect-metadata";

// On macOS, bun:sqlite ships without dynamic extension loading (needed for
// sqlite-vec). Swap to homebrew's libsqlite3 once for the whole test process,
// before any test imports `bun:sqlite`. setCustomSQLite throws if called after
// SQLite is already loaded; swallow that so this remains safe to call from
// individual test files too.
import { Database } from "bun:sqlite";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded in this process */
}

// Job resource scopes (core/process/resource-scope.ts) wrap real spawns in
// `systemd-run --user --scope` when the host supports it. Default them off
// under test — unconditionally, since dispatched agents inherit the worker's
// env — so argv assertions and spawn timing are host-independent. Tests that
// exercise scoping inject their own config.
process.env.PENUMBRA_JOB_SCOPE = "off";
