// Polyfill Reflect metadata API required by NestJS decorators.
// Must be loaded before any @nestjs/common import.
import 'reflect-metadata';

// On macOS, bun:sqlite ships without dynamic extension loading (needed for
// sqlite-vec). Swap to homebrew's libsqlite3 once for the whole test process,
// before any test imports `bun:sqlite`. setCustomSQLite throws if called after
// SQLite is already loaded; swallow that so this remains safe to call from
// individual test files too.
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded in this process */ }
