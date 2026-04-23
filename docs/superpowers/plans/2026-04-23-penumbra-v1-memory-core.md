# Penumbra V1 Foundation + Tool 1 (Memory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Penumbra V1 foundation and Tool 1 (cross-agent memory via MCP) — daemon, SQLite+sqlite-vec storage, MCP observe/recall, T1 session rollups, atomic context-file writes, and a functional CLI.

**Architecture:** Bun workspace monorepo with an adapter-free `core` package, a `daemon` HTTP service owning SQLite+sqlite-vec, an MCP stdio proxy, and a CLI. All workers run in-process on a shared scheduler inside the daemon. Services container built at daemon startup; no import-time singletons. Every subprocess tracked in a PID registry with real liveness checks.

**Tech Stack:** Bun 1.3+, TypeScript 5.9+ strict NodeNext ESM, `@modelcontextprotocol/sdk` 1.29.0, Zod 4.3+, `@nova/contracts` + `@nova/mcp-shared` via `file:` deps, `bun:sqlite`, sqlite-vec loadable extension, `fastembed` (or ONNX Runtime + quantized MiniLM) for the bundled embedder, pino for structured logs. All tests via `bun:test` — no mocks for SQLite, HTTP, or the embedder at integration layer.

**Scope in this plan:**
- V1 shared foundation (daemon, DB, core utilities, services container, PID registry, scheduler, worker supervisor).
- Tool 1 MCP ingest (`memory.observe`, `memory.recall`, `session.end`).
- T0 storage + multi-signal T1 rollup + context-file writer.
- CLI: `init`, `start`, `stop`, `status`, `export`, `import`, `repair`.
- Forcing-function smoke test: one end-to-end MCP→daemon→DB→recall round-trip.

**Deferred to separate plans:**
- Tool 2 (dream mode, embersynth integration).
- Tool 3 (routing advisories, DuckDB analytics).
- Transcript-watcher integration.
- Sirius-middleware integration.
- Viewer UI (beyond `/health`).
- Advisor agent.

**Prerequisite reading for the engineer:**
- `docs/superpowers/specs/2026-04-23-penumbra-design.md` — the full V1 spec. Every decision here maps back to a decision in the spec.
- `/Volumes/WorkSSD/repos/personal/nova/README.md` + `AGENTS.md` — `@nova/contracts` and `@nova/mcp-shared` usage.
- `/Volumes/WorkSSD/repos/personal/llamactl/AGENTS.md` — conventions adopted here: dispatcher pattern, Zod 4 idioms, MCP SDK 1.29.0 patterns.

---

## Sprint A — Workspace, branding, settings, clock/uuid (Tasks 1–8)

### Task 1: Initialize Bun workspace root

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `README.md`

- [ ] **Step 1: Write the root `package.json`**

```json
{
  "name": "penumbra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -b"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 3: Write `tsconfig.json` (project-references root)**

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/daemon" },
    { "path": "./packages/mcp" },
    { "path": "./packages/cli" }
  ]
}
```

- [ ] **Step 4: Write a minimal `README.md`** (discovery only; no rich docs)

```markdown
# penumbra

Local-first memory, compression, and learned-routing layer for hybrid-AI workflows. Sibling to Nova, Sirius-Gateway, EmberSynth, and LlamaCtl.

See `docs/superpowers/specs/` for the V1 design. See `docs/superpowers/plans/` for implementation plans.
```

- [ ] **Step 5: Install root devDependencies**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install
```

Expected: `bun install` completes; `bun.lockb` written.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json tsconfig.json README.md bun.lockb && \
  git commit -m "chore: bootstrap Bun workspace"
```

---

### Task 2: Scaffold the `core` package

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/sanity.test.ts`

- [ ] **Step 1: Write `packages/core/package.json`**

```json
{
  "name": "@penumbra/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "^4.3.0",
    "@nova/contracts": "file:../../../nova/packages/contracts",
    "@nova/mcp-shared": "file:../../../nova/packages/mcp-shared",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "@types/node": "latest"
  }
}
```

- [ ] **Step 2: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write the barrel `src/index.ts` (empty export; filled as modules land)**

```ts
export {};
```

- [ ] **Step 4: Write a sanity test at `test/sanity.test.ts`**

```ts
import { expect, test } from 'bun:test';

test('core package loads', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Install and run the sanity test**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install && bun test packages/core
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core && git commit -m "chore(core): scaffold @penumbra/core package"
```

---

### Task 3: Branding constant (pain #4)

**Files:**
- Create: `packages/core/src/branding.ts`
- Create: `packages/core/test/branding.test.ts`

- [ ] **Step 1: Write the failing test at `test/branding.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { Branding } from '../src/branding.js';

test('branding exposes product name, slug, and storage root', () => {
  expect(Branding.name).toBe('Penumbra');
  expect(Branding.slug).toBe('penumbra');
  expect(Branding.envPrefix).toBe('PENUMBRA');
  expect(Branding.storageRoot).toMatch(/\.penumbra$/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/core/test/branding.test.ts`
Expected: FAIL (`Cannot find module '../src/branding.js'`).

- [ ] **Step 3: Write `src/branding.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export const Branding = {
  name: 'Penumbra',
  slug: 'penumbra',
  envPrefix: 'PENUMBRA',
  storageRoot: join(homedir(), '.penumbra'),
} as const;
```

- [ ] **Step 4: Re-run the test**

Run: `bun test packages/core/test/branding.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-export from the barrel**

Modify `packages/core/src/index.ts`:

```ts
export { Branding } from './branding.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/branding.ts packages/core/src/index.ts packages/core/test/branding.test.ts && \
  git commit -m "feat(core): add Branding constant (single source of vendor strings)"
```

---

### Task 4: Clock and UUID injection utilities

**Files:**
- Create: `packages/core/src/utils/clock.ts`
- Create: `packages/core/src/utils/uuid.ts`
- Create: `packages/core/test/utils/clock.test.ts`
- Create: `packages/core/test/utils/uuid.test.ts`

- [ ] **Step 1: Write `test/utils/clock.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { type Clock, systemClock } from '../../src/utils/clock.js';

test('systemClock returns a Date within 100ms of now', () => {
  const before = Date.now();
  const d = systemClock();
  const after = Date.now();
  expect(d.getTime()).toBeGreaterThanOrEqual(before);
  expect(d.getTime()).toBeLessThanOrEqual(after + 100);
});

test('Clock type is a zero-arg function returning Date', () => {
  const fixed: Clock = () => new Date('2026-04-23T12:00:00Z');
  expect(fixed().toISOString()).toBe('2026-04-23T12:00:00.000Z');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/utils/clock.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `src/utils/clock.ts`**

```ts
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
```

- [ ] **Step 4: Write `test/utils/uuid.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { type Uuid, systemUuid } from '../../src/utils/uuid.js';

test('systemUuid returns a v4-shaped string', () => {
  const id = systemUuid();
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('Uuid type is a zero-arg function returning string', () => {
  const counter = ((): Uuid => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  })();
  expect(counter()).toBe('00000000-0000-4000-8000-000000000001');
  expect(counter()).toBe('00000000-0000-4000-8000-000000000002');
});
```

- [ ] **Step 5: Write `src/utils/uuid.ts`**

```ts
import { randomUUID } from 'node:crypto';

export type Uuid = () => string;
export const systemUuid: Uuid = () => randomUUID();
```

- [ ] **Step 6: Run both — expect pass**

Run: `bun test packages/core/test/utils/`
Expected: 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/utils packages/core/test/utils && \
  git commit -m "feat(core): add Clock and Uuid injection types (pain #3 remediation)"
```

---

### Task 5: Settings defaults manager (pain #1)

**Files:**
- Create: `packages/core/src/settings.ts`
- Create: `packages/core/test/settings.test.ts`

- [ ] **Step 1: Write `test/settings.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { SettingsDefaults, type SettingsInput } from '../src/settings.js';

test('returns defaults when nothing is overridden', () => {
  const env: NodeJS.ProcessEnv = {};
  const s = SettingsDefaults.build({ env, input: {} });
  expect(s.t0RetentionDays).toBe(14);
  expect(s.t1RollupIntervalSec).toBe(60);
  expect(s.t1SessionIdleMinutes).toBe(10);
  expect(s.backupRetentionDays).toBe(7);
});

test('env var override beats default', () => {
  const env: NodeJS.ProcessEnv = { PENUMBRA_T0_RETENTION_DAYS: '30' };
  const s = SettingsDefaults.build({ env, input: {} });
  expect(s.t0RetentionDays).toBe(30);
});

test('explicit input beats env var', () => {
  const env: NodeJS.ProcessEnv = { PENUMBRA_T0_RETENTION_DAYS: '30' };
  const input: SettingsInput = { t0RetentionDays: 5 };
  const s = SettingsDefaults.build({ env, input });
  expect(s.t0RetentionDays).toBe(5);
});

test('invalid env var number falls back to default and is reported', () => {
  const env: NodeJS.ProcessEnv = { PENUMBRA_T0_RETENTION_DAYS: 'banana' };
  const { settings, warnings } = SettingsDefaults.buildWithWarnings({ env, input: {} });
  expect(settings.t0RetentionDays).toBe(14);
  expect(warnings[0]).toMatch(/PENUMBRA_T0_RETENTION_DAYS/);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/settings.test.ts`
Expected: FAIL (missing module).

- [ ] **Step 3: Write `src/settings.ts`**

```ts
import { z } from 'zod';

export const SettingsSchema = z.object({
  t0RetentionDays: z.number().int().positive().default(14),
  t1RollupIntervalSec: z.number().int().positive().default(60),
  t1SessionIdleMinutes: z.number().int().positive().default(10),
  backupRetentionDays: z.number().int().positive().default(7),
  dreamModeStrategy: z.enum(['embersynth', 'local', 'skip']).default('local'),
  embedderPreferSirius: z.boolean().default(true),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = Partial<Settings>;

const envKeyFor: Record<keyof Settings, string> = {
  t0RetentionDays: 'PENUMBRA_T0_RETENTION_DAYS',
  t1RollupIntervalSec: 'PENUMBRA_T1_ROLLUP_INTERVAL_SEC',
  t1SessionIdleMinutes: 'PENUMBRA_T1_SESSION_IDLE_MINUTES',
  backupRetentionDays: 'PENUMBRA_BACKUP_RETENTION_DAYS',
  dreamModeStrategy: 'PENUMBRA_DREAM_MODE_STRATEGY',
  embedderPreferSirius: 'PENUMBRA_EMBEDDER_PREFER_SIRIUS',
};

const parsers: Record<keyof Settings, (raw: string) => unknown> = {
  t0RetentionDays: Number,
  t1RollupIntervalSec: Number,
  t1SessionIdleMinutes: Number,
  backupRetentionDays: Number,
  dreamModeStrategy: (s) => s,
  embedderPreferSirius: (s) => s === 'true' || s === '1',
};

export const SettingsDefaults = {
  build(opts: { env: NodeJS.ProcessEnv; input: SettingsInput }): Settings {
    return this.buildWithWarnings(opts).settings;
  },

  buildWithWarnings(opts: {
    env: NodeJS.ProcessEnv;
    input: SettingsInput;
  }): { settings: Settings; warnings: string[] } {
    const warnings: string[] = [];
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(envKeyFor) as (keyof Settings)[]) {
      const envVar = envKeyFor[key];
      const raw = opts.env[envVar];
      if (raw !== undefined) {
        const parsed = parsers[key](raw);
        const check = SettingsSchema.shape[key].safeParse(parsed);
        if (check.success) merged[key] = check.data;
        else warnings.push(`invalid ${envVar}=${raw}, using default`);
      }
    }
    const settings = SettingsSchema.parse({ ...merged, ...opts.input });
    return { settings, warnings };
  },
};
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/settings.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Re-export**

Modify `packages/core/src/index.ts`:

```ts
export { Branding } from './branding.js';
export { SettingsDefaults, SettingsSchema, type Settings, type SettingsInput } from './settings.js';
export { systemClock, type Clock } from './utils/clock.js';
export { systemUuid, type Uuid } from './utils/uuid.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/settings.ts packages/core/src/index.ts packages/core/test/settings.test.ts && \
  git commit -m "feat(core): SettingsDefaults with env-var overrides (pain #1 remediation)"
```

---

### Task 6: Machine-id generation (per-install UUID)

**Files:**
- Create: `packages/core/src/identity/machine-id.ts`
- Create: `packages/core/test/identity/machine-id.test.ts`

- [ ] **Step 1: Write `test/identity/machine-id.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineId } from '../../src/identity/machine-id.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'penumbra-mid-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('reads existing machine-id file and returns its UUID', () => {
  const idPath = join(dir, 'machine-id');
  Bun.write(idPath, '11111111-1111-4111-8111-111111111111');
  const mid = new MachineId({ storageRoot: dir });
  expect(mid.get()).toBe('11111111-1111-4111-8111-111111111111');
});

test('creates a new machine-id file on first call', () => {
  const mid = new MachineId({ storageRoot: dir, uuid: () => 'fixed-uuid' });
  expect(mid.get()).toBe('fixed-uuid');
  expect(existsSync(join(dir, 'machine-id'))).toBe(true);
  expect(readFileSync(join(dir, 'machine-id'), 'utf8').trim()).toBe('fixed-uuid');
});

test('subsequent calls return the cached value without re-reading', () => {
  const mid = new MachineId({ storageRoot: dir, uuid: () => 'a' });
  expect(mid.get()).toBe('a');
  // Overwrite the file — cache should still return 'a'.
  Bun.write(join(dir, 'machine-id'), 'b');
  expect(mid.get()).toBe('a');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/identity/machine-id.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/identity/machine-id.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemUuid, type Uuid } from '../utils/uuid.js';

export class MachineId {
  private cached: string | null = null;
  private readonly path: string;
  private readonly uuid: Uuid;

  constructor(opts: { storageRoot: string; uuid?: Uuid }) {
    this.path = join(opts.storageRoot, 'machine-id');
    this.uuid = opts.uuid ?? systemUuid;
  }

  get(): string {
    if (this.cached) return this.cached;
    if (existsSync(this.path)) {
      this.cached = readFileSync(this.path, 'utf8').trim();
      return this.cached;
    }
    const fresh = this.uuid();
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, fresh + '\n', { mode: 0o600 });
    this.cached = fresh;
    return fresh;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/identity/machine-id.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity packages/core/test/identity && \
  git commit -m "feat(core): MachineId per-install UUID (persisted, cached, injectable)"
```

---

### Task 7: Structured logger wrapper around pino

**Files:**
- Create: `packages/core/src/logger.ts`
- Create: `packages/core/test/logger.test.ts`

- [ ] **Step 1: Write `test/logger.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { createLogger } from '../src/logger.js';

test('createLogger returns a pino logger with the component field baked in', () => {
  const log = createLogger({ component: 'test', level: 'silent' });
  // Surface-level shape checks only — we trust pino's own tests.
  expect(typeof log.info).toBe('function');
  expect(typeof log.error).toBe('function');
  expect(typeof log.child).toBe('function');
});

test('logger.child propagates component', () => {
  const root = createLogger({ component: 'parent', level: 'silent' });
  const kid = root.child({ component: 'child' });
  expect(typeof kid.info).toBe('function');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/logger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/logger.ts`**

```ts
import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(opts: {
  component: string;
  level?: pino.Level | 'silent';
}): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { component: opts.component },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/logger.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logger.ts packages/core/test/logger.test.ts && \
  git commit -m "feat(core): structured logger factory (pino wrapper)"
```

---

### Task 8: Regex redactor (privacy boundary — pain #5-adjacent)

**Files:**
- Create: `packages/core/src/redaction/regex.ts`
- Create: `packages/core/src/redaction/privacy-tags.ts`
- Create: `packages/core/test/redaction/regex.test.ts`
- Create: `packages/core/test/redaction/privacy-tags.test.ts`

- [ ] **Step 1: Write `test/redaction/regex.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { RegexRedactor, DEFAULT_REDACTION_RULES } from '../../src/redaction/regex.js';

test('redacts default secret-like keys', () => {
  const r = new RegexRedactor(DEFAULT_REDACTION_RULES);
  const out = r.redact({ api_key: 'sk-abc', password: 'hunter2', ok: 'fine' });
  expect(out.api_key).toBe('[REDACTED]');
  expect(out.password).toBe('[REDACTED]');
  expect(out.ok).toBe('fine');
});

test('redacts nested values', () => {
  const r = new RegexRedactor(DEFAULT_REDACTION_RULES);
  const out = r.redact({ a: { token: 'xyz', b: 1 } });
  expect((out.a as Record<string, unknown>).token).toBe('[REDACTED]');
  expect((out.a as Record<string, unknown>).b).toBe(1);
});

test('never mutates the input', () => {
  const r = new RegexRedactor(DEFAULT_REDACTION_RULES);
  const input = { password: 'p' };
  r.redact(input);
  expect(input.password).toBe('p');
});
```

- [ ] **Step 2: Write `test/redaction/privacy-tags.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { stripPrivacyTags } from '../../src/redaction/privacy-tags.js';

test('removes content inside <private>...</private>', () => {
  expect(stripPrivacyTags('keep <private>drop me</private> keep')).toBe('keep  keep');
});

test('handles multiple tags', () => {
  expect(stripPrivacyTags('a <private>x</private> b <private>y</private> c'))
    .toBe('a  b  c');
});

test('leaves text without tags unchanged', () => {
  expect(stripPrivacyTags('no tags here')).toBe('no tags here');
});

test('handles multiline content', () => {
  const src = 'start\n<private>\nsecret line 1\nsecret line 2\n</private>\nend';
  expect(stripPrivacyTags(src)).toBe('start\n\nend');
});
```

- [ ] **Step 3: Run both — expect fail**

Run: `bun test packages/core/test/redaction/`
Expected: FAIL (missing modules).

- [ ] **Step 4: Write `src/redaction/regex.ts`**

```ts
export interface RedactionRule {
  keyPattern: RegExp;
}

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { keyPattern: /^(password|passwd|pwd)$/i },
  { keyPattern: /^(api[_-]?key|apikey)$/i },
  { keyPattern: /^(token|access[_-]?token|refresh[_-]?token)$/i },
  { keyPattern: /^(secret|client[_-]?secret)$/i },
  { keyPattern: /^authorization$/i },
];

export class RegexRedactor {
  constructor(private rules: RedactionRule[]) {}

  redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.rules.some((r) => r.keyPattern.test(k))
          ? '[REDACTED]'
          : this.redact(v);
      }
      return out;
    }
    return value;
  }
}
```

- [ ] **Step 5: Write `src/redaction/privacy-tags.ts`**

```ts
const TAG_RE = /<private>[\s\S]*?<\/private>/g;

export function stripPrivacyTags(text: string): string {
  return text.replace(TAG_RE, '');
}
```

- [ ] **Step 6: Run both — expect pass**

Run: `bun test packages/core/test/redaction/`
Expected: 7 tests pass.

- [ ] **Step 7: Re-export**

Modify `packages/core/src/index.ts` to add:

```ts
export { RegexRedactor, DEFAULT_REDACTION_RULES, type RedactionRule } from './redaction/regex.js';
export { stripPrivacyTags } from './redaction/privacy-tags.js';
export { MachineId } from './identity/machine-id.js';
export { createLogger, type Logger } from './logger.js';
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/redaction packages/core/src/index.ts packages/core/test/redaction && \
  git commit -m "feat(core): regex redactor + privacy-tag stripper (edge privacy)"
```

---

## Sprint B — Database, schemas, db_meta (Tasks 9–14)

### Task 9: sqlite-vec extension loader

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/db/sqlite-vec.ts`
- Create: `packages/core/test/db/sqlite-vec.test.ts`

- [ ] **Step 1: Add `sqlite-vec` to `packages/core/package.json` dependencies**

Modify `packages/core/package.json`, adding under `"dependencies"`:

```json
"sqlite-vec": "^0.1.6"
```

Then run:

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install
```

- [ ] **Step 2: Write `test/db/sqlite-vec.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';

let db: Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

test('loadSqliteVec enables vec0 virtual tables', () => {
  loadSqliteVec(db);
  db.run('CREATE VIRTUAL TABLE v USING vec0(embedding FLOAT[4])');
  const rows = db.query('SELECT name FROM sqlite_master WHERE type=?').all('table');
  expect(rows.length).toBeGreaterThanOrEqual(1);
});

test('can insert and query a vector', () => {
  loadSqliteVec(db);
  db.run('CREATE VIRTUAL TABLE v USING vec0(embedding FLOAT[4])');
  db.run('INSERT INTO v(rowid, embedding) VALUES (?, ?)', [
    1,
    new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer,
  ]);
  const rows = db.query('SELECT rowid FROM v').all() as { rowid: number }[];
  expect(rows[0]?.rowid).toBe(1);
});
```

- [ ] **Step 3: Run — expect fail**

Run: `bun test packages/core/test/db/sqlite-vec.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/db/sqlite-vec.ts`**

```ts
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

export function loadSqliteVec(db: Database): void {
  sqliteVec.load(db);
}
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/core/test/db/sqlite-vec.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/db packages/core/test/db bun.lockb && \
  git commit -m "feat(core): sqlite-vec extension loader with smoke test"
```

---

### Task 10: Database schema module (CREATE TABLE statements)

**Files:**
- Create: `packages/core/src/db/schema.ts`
- Create: `packages/core/test/db/schema.test.ts`

- [ ] **Step 1: Write `test/db/schema.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { applySchema, SCHEMA_VERSION } from '../../src/db/schema.js';

test('applySchema creates all tables', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const tables = db
    .query<{ name: string }, []>('SELECT name FROM sqlite_master WHERE type=?')
    .all('table')
    .map((r) => r.name);
  expect(tables).toContain('t0_events');
  expect(tables).toContain('t1_rollups');
  expect(tables).toContain('t2_memories');
  expect(tables).toContain('projects');
  expect(tables).toContain('recall_audit');
  expect(tables).toContain('db_meta');
});

test('applySchema creates vec0 companion tables', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  db.run('INSERT INTO t1_vec(rowid, embedding) VALUES (?, ?)', [
    1,
    new Float32Array(384).buffer,
  ]);
  expect(
    db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_vec').get()?.c,
  ).toBe(1);
});

test('SCHEMA_VERSION is an integer', () => {
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/db/schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/db/schema.ts`**

```ts
import { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 1;

export function applySchema(
  db: Database,
  opts: { embeddingDim?: number } = {},
): void {
  const dim = opts.embeddingDim ?? 384;
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS db_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id        TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        git_remote        TEXT,
        git_relpath_root  TEXT,
        marker_uuid       TEXT,
        display_name      TEXT,
        first_seen_paths  TEXT NOT NULL DEFAULT '[]',
        created_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS t0_events (
        event_id         TEXT PRIMARY KEY,
        ts               TEXT NOT NULL,
        ingest_ts        TEXT NOT NULL,
        source           TEXT NOT NULL,
        source_detail    TEXT,
        project_id       TEXT,
        user_id          TEXT NOT NULL,
        machine_id       TEXT NOT NULL,
        session_id       TEXT,
        event_type       TEXT NOT NULL,
        lane             TEXT NOT NULL,
        provider         TEXT,
        model            TEXT,
        tokens_in        INTEGER,
        tokens_out       INTEGER,
        cost_usd         REAL,
        latency_ms       INTEGER,
        request_id       TEXT,
        payload_json     TEXT NOT NULL,
        payload_summary  TEXT
      );
      CREATE INDEX IF NOT EXISTS t0_by_project_session ON t0_events(project_id, session_id, ts);
      CREATE INDEX IF NOT EXISTS t0_by_ingest_ts        ON t0_events(ingest_ts);

      CREATE TABLE IF NOT EXISTS t1_rollups (
        rollup_id               TEXT PRIMARY KEY,
        project_id              TEXT,
        user_id                 TEXT NOT NULL,
        session_id              TEXT NOT NULL,
        started_at              TEXT NOT NULL,
        ended_at                TEXT,
        n_events                INTEGER NOT NULL,
        lane_breakdown_json     TEXT NOT NULL DEFAULT '{}',
        provider_breakdown_json TEXT NOT NULL DEFAULT '{}',
        cost_usd_total          REAL,
        tokens_in_total         INTEGER,
        tokens_out_total        INTEGER,
        first_prompt_excerpt    TEXT,
        last_response_excerpt   TEXT,
        tool_calls_summary      TEXT,
        source_event_ids        TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS t1_by_project     ON t1_rollups(project_id, ended_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS t1_session ON t1_rollups(session_id);

      CREATE TABLE IF NOT EXISTS t2_memories (
        memory_id          TEXT PRIMARY KEY,
        project_id         TEXT,
        user_id            TEXT NOT NULL,
        kind               TEXT NOT NULL,
        source_session_ids TEXT NOT NULL DEFAULT '[]',
        window_start       TEXT NOT NULL,
        window_end         TEXT NOT NULL,
        title              TEXT NOT NULL,
        body               TEXT NOT NULL,
        metadata_json      TEXT NOT NULL DEFAULT '{}',
        compressed_from    TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS t2_by_project ON t2_memories(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS recall_audit (
        recall_id   TEXT PRIMARY KEY,
        ts          TEXT NOT NULL,
        project_id  TEXT,
        user_id     TEXT NOT NULL,
        query_text  TEXT,
        result_ids  TEXT NOT NULL DEFAULT '[]'
      );
    `);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t1_vec USING vec0(embedding FLOAT[${dim}])`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t2_vec USING vec0(embedding FLOAT[${dim}])`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/db/schema.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/schema.test.ts && \
  git commit -m "feat(core): DB schema — T0/T1/T2/projects/recall_audit + vec0 tables"
```

---

### Task 11: db_meta read/write helpers

**Files:**
- Create: `packages/core/src/db/meta.ts`
- Create: `packages/core/test/db/meta.test.ts`

- [ ] **Step 1: Write `test/db/meta.test.ts`**

```ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { applySchema } from '../../src/db/schema.js';
import { DbMeta } from '../../src/db/meta.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
});

test('set and get roundtrip', () => {
  const m = new DbMeta(db);
  m.set('embedder_name', 'minilm');
  expect(m.get('embedder_name')).toBe('minilm');
});

test('get returns undefined for missing key', () => {
  const m = new DbMeta(db);
  expect(m.get('nope')).toBeUndefined();
});

test('set overwrites existing value', () => {
  const m = new DbMeta(db);
  m.set('k', 'v1');
  m.set('k', 'v2');
  expect(m.get('k')).toBe('v2');
});

test('getNumber parses and returns typed values', () => {
  const m = new DbMeta(db);
  m.set('dim', '384');
  expect(m.getNumber('dim')).toBe(384);
  expect(m.getNumber('missing')).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/db/meta.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/db/meta.ts`**

```ts
import { Database } from 'bun:sqlite';

export class DbMeta {
  constructor(private db: Database) {}

  get(key: string): string | undefined {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM db_meta WHERE key=?')
      .get(key);
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      'INSERT INTO db_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value],
    );
  }

  getNumber(key: string): number | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/db/meta.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/meta.ts packages/core/test/db/meta.test.ts && \
  git commit -m "feat(core): DbMeta key/value helper for embedder dim, schema version, etc."
```

---

### Task 12: Database migrator (applies schema, records version in db_meta)

**Files:**
- Create: `packages/core/src/db/migrations.ts`
- Create: `packages/core/test/db/migrations.test.ts`

- [ ] **Step 1: Write `test/db/migrations.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';

test('migrate applies schema and records version on a fresh db', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const v = db
    .query<{ value: string }, [string]>('SELECT value FROM db_meta WHERE key=?')
    .get('schema_version');
  expect(v?.value).toBe(String(SCHEMA_VERSION));
});

test('migrate is idempotent', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  migrate(db, { embeddingDim: 384 });
  const tables = db
    .query<{ name: string }, []>('SELECT name FROM sqlite_master WHERE type=?')
    .all('table').length;
  expect(tables).toBeGreaterThan(5);
});

test('migrate rejects a mismatched embedding dim on a non-empty db', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  expect(() => migrate(db, { embeddingDim: 1536 })).toThrow(/embedding_dim/);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/db/migrations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/db/migrations.ts`**

```ts
import { Database } from 'bun:sqlite';
import { applySchema, SCHEMA_VERSION } from './schema.js';
import { DbMeta } from './meta.js';

export interface MigrateOpts {
  embeddingDim: number;
}

export function migrate(db: Database, opts: MigrateOpts): void {
  applySchema(db, { embeddingDim: opts.embeddingDim });
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber('embedding_dim');
  if (storedDim !== undefined && storedDim !== opts.embeddingDim) {
    throw new Error(
      `embedding_dim mismatch: stored=${storedDim} requested=${opts.embeddingDim}. ` +
        `Run 'penumbra reembed' to change.`,
    );
  }
  meta.set('schema_version', String(SCHEMA_VERSION));
  meta.set('embedding_dim', String(opts.embeddingDim));
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/db/migrations.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/migrations.ts packages/core/test/db/migrations.test.ts && \
  git commit -m "feat(core): migrator with embedding_dim drift guard"
```

---

### Task 13: T0 event Zod schema

**Files:**
- Create: `packages/core/src/schemas/event.ts`
- Create: `packages/core/test/schemas/event.test.ts`

- [ ] **Step 1: Write `test/schemas/event.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { T0EventSchema, T0EventInputSchema } from '../../src/schemas/event.js';

test('parses a complete T0 event', () => {
  const e = T0EventSchema.parse({
    event_id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-04-23T12:00:00.000Z',
    ingest_ts: '2026-04-23T12:00:00.100Z',
    source: 'mcp',
    source_detail: 'claude-code',
    project_id: null,
    user_id: '22222222-2222-4222-8222-222222222222',
    machine_id: '33333333-3333-4333-8333-333333333333',
    session_id: 'sess-1',
    event_type: 'agent-tool-use',
    lane: 'local',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { tool: 'Read' },
    payload_summary: 'Read src/x.ts',
  });
  expect(e.source).toBe('mcp');
  expect(e.payload_json).toEqual({ tool: 'Read' });
});

test('T0EventInputSchema makes event_id + ingest_ts optional', () => {
  const parsed = T0EventInputSchema.parse({
    ts: '2026-04-23T12:00:00.000Z',
    source: 'mcp',
    user_id: 'u',
    machine_id: 'm',
    event_type: 'agent-prompt',
    lane: 'cloud',
    payload_json: {},
  });
  expect(parsed.event_id).toBeUndefined();
});

test('rejects invalid source', () => {
  expect(() =>
    T0EventSchema.parse({
      event_id: 'x', ts: 'x', ingest_ts: 'x', source: 'oops', user_id: 'u',
      machine_id: 'm', event_type: 'agent-prompt', lane: 'cloud',
      payload_json: {}, project_id: null, session_id: null,
      source_detail: null, provider: null, model: null, tokens_in: null,
      tokens_out: null, cost_usd: null, latency_ms: null, request_id: null,
      payload_summary: null,
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/schemas/event.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/schemas/event.ts`**

```ts
import { z } from 'zod';

export const SourceSchema = z.enum(['mcp', 'transcript', 'sirius-middleware']);
export const LaneSchema = z.enum(['local', 'cloud', 'cli-subscription', 'unknown']);
export const EventTypeSchema = z.enum([
  'agent-prompt',
  'agent-tool-use',
  'agent-response',
  'request',
  'response',
]);

export const T0EventSchema = z.object({
  event_id: z.string(),
  ts: z.string(),
  ingest_ts: z.string(),
  source: SourceSchema,
  source_detail: z.string().nullable(),
  project_id: z.string().nullable(),
  user_id: z.string(),
  machine_id: z.string(),
  session_id: z.string().nullable(),
  event_type: EventTypeSchema,
  lane: LaneSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  request_id: z.string().nullable(),
  payload_json: z.record(z.string(), z.unknown()),
  payload_summary: z.string().nullable(),
});

export type T0Event = z.infer<typeof T0EventSchema>;

export const T0EventInputSchema = T0EventSchema.partial({
  event_id: true,
  ingest_ts: true,
  source_detail: true,
  project_id: true,
  session_id: true,
  provider: true,
  model: true,
  tokens_in: true,
  tokens_out: true,
  cost_usd: true,
  latency_ms: true,
  request_id: true,
  payload_summary: true,
});

export type T0EventInput = z.infer<typeof T0EventInputSchema>;
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/schemas/event.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event.test.ts && \
  git commit -m "feat(core): Zod schemas for T0 event (strict + input variant)"
```

---

### Task 14: T1 rollup, project, and recall Zod schemas

**Files:**
- Create: `packages/core/src/schemas/rollup.ts`
- Create: `packages/core/src/schemas/project.ts`
- Create: `packages/core/src/schemas/recall.ts`
- Create: `packages/core/test/schemas/misc.test.ts`

- [ ] **Step 1: Write `test/schemas/misc.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { T1RollupSchema } from '../../src/schemas/rollup.js';
import { ProjectSchema } from '../../src/schemas/project.js';
import { RecallRequestSchema, RecallResultSchema } from '../../src/schemas/recall.js';

test('T1 rollup parses a minimal row', () => {
  const r = T1RollupSchema.parse({
    rollup_id: 'r1',
    project_id: null,
    user_id: 'u',
    session_id: 's',
    started_at: '2026-04-23T12:00:00Z',
    ended_at: '2026-04-23T12:30:00Z',
    n_events: 5,
    lane_breakdown: { local: 5 },
    provider_breakdown: {},
    cost_usd_total: null,
    tokens_in_total: 0,
    tokens_out_total: 0,
    first_prompt_excerpt: null,
    last_response_excerpt: null,
    tool_calls_summary: null,
    source_event_ids: [],
  });
  expect(r.rollup_id).toBe('r1');
});

test('ProjectSchema enforces kind enum', () => {
  expect(() =>
    ProjectSchema.parse({
      project_id: 'p',
      kind: 'bogus',
      git_remote: null,
      git_relpath_root: null,
      marker_uuid: null,
      display_name: null,
      first_seen_paths: [],
      created_at: 'x',
    }),
  ).toThrow();
});

test('RecallRequestSchema requires query', () => {
  const r = RecallRequestSchema.parse({ query: 'find me', project_id: null, limit: 10 });
  expect(r.query).toBe('find me');
});

test('RecallResultSchema validates provenance', () => {
  const r = RecallResultSchema.parse({
    id: 'x',
    tier: 't1',
    score: 0.9,
    title: 'Session X',
    body: 'some text',
    project_id: null,
    source_session_ids: ['s1'],
    created_at: 't',
  });
  expect(r.tier).toBe('t1');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/schemas/misc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/schemas/rollup.ts`**

```ts
import { z } from 'zod';

export const T1RollupSchema = z.object({
  rollup_id: z.string(),
  project_id: z.string().nullable(),
  user_id: z.string(),
  session_id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  n_events: z.number().int().nonnegative(),
  lane_breakdown: z.record(z.string(), z.number()),
  provider_breakdown: z.record(z.string(), z.number()),
  cost_usd_total: z.number().nullable(),
  tokens_in_total: z.number().int().nullable(),
  tokens_out_total: z.number().int().nullable(),
  first_prompt_excerpt: z.string().nullable(),
  last_response_excerpt: z.string().nullable(),
  tool_calls_summary: z.string().nullable(),
  source_event_ids: z.array(z.string()),
});

export type T1Rollup = z.infer<typeof T1RollupSchema>;
```

- [ ] **Step 4: Write `src/schemas/project.ts`**

```ts
import { z } from 'zod';

export const ProjectKindSchema = z.enum(['git', 'marker', 'declared']);

export const ProjectSchema = z.object({
  project_id: z.string(),
  kind: ProjectKindSchema,
  git_remote: z.string().nullable(),
  git_relpath_root: z.string().nullable(),
  marker_uuid: z.string().nullable(),
  display_name: z.string().nullable(),
  first_seen_paths: z.array(z.string()),
  created_at: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;
```

- [ ] **Step 5: Write `src/schemas/recall.ts`**

```ts
import { z } from 'zod';

export const RecallRequestSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().nullable(),
  limit: z.number().int().positive().max(200).default(20),
  include_raw: z.boolean().default(false),
  min_score: z.number().min(0).max(1).default(0),
});

export type RecallRequest = z.infer<typeof RecallRequestSchema>;

export const RecallResultSchema = z.object({
  id: z.string(),
  tier: z.enum(['t0', 't1', 't2']),
  score: z.number(),
  title: z.string().nullable(),
  body: z.string(),
  project_id: z.string().nullable(),
  source_session_ids: z.array(z.string()),
  created_at: z.string(),
});

export type RecallResult = z.infer<typeof RecallResultSchema>;
```

- [ ] **Step 6: Run — expect pass**

Run: `bun test packages/core/test/schemas/misc.test.ts`
Expected: 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schemas packages/core/test/schemas && \
  git commit -m "feat(core): Zod schemas for T1 rollup, project, recall request/result"
```

---

## Sprint C — Project identity, cache, normalizer, T0 writer (Tasks 15–19)

### Task 15: Project-id resolver — git case

**Files:**
- Create: `packages/core/src/identity/project-id.ts`
- Create: `packages/core/test/identity/project-id-git.test.ts`

- [ ] **Step 1: Write `test/identity/project-id-git.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectId } from '../../src/identity/project-id.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-pid-git-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.com/foo/bar.git'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '#');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('resolves a git repo at the root to kind=git with deterministic id', () => {
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe('git');
  expect(r.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test('resolves a subdirectory with relpath appended', () => {
  const sub = join(dir, 'packages', 'x');
  mkdirSync(sub, { recursive: true });
  const r = resolveProjectId({ cwd: sub });
  expect(r.kind).toBe('git');
  expect(r.project_id).toMatch(/:packages\/x$/);
});

test('two cwds in the same repo produce the same project-id prefix', () => {
  const a = resolveProjectId({ cwd: dir });
  mkdirSync(join(dir, 'sub'));
  const b = resolveProjectId({ cwd: join(dir, 'sub') });
  expect(a.project_id.split(':')[0]).toBe(b.project_id.split(':')[0]);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/identity/project-id-git.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/identity/project-id.ts`**

```ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ProjectResolution =
  | { kind: 'git'; project_id: string; git_remote: string; git_relpath_root: string; repo_root: string }
  | { kind: 'marker'; project_id: string; marker_uuid: string; marker_path: string }
  | { kind: 'declared'; project_id: string }
  | { kind: 'quarantine'; project_id: null };

export interface ResolveOpts {
  cwd: string;
  declaredProjectId?: string;
  markerFileName?: string;
}

const DEFAULT_MARKER = '.penumbra-project';

export function resolveProjectId(opts: ResolveOpts): ProjectResolution {
  if (opts.declaredProjectId) return { kind: 'declared', project_id: opts.declaredProjectId };

  const git = tryGit(opts.cwd);
  if (git) {
    const hash = createHash('sha256').update(git.remote).digest('hex').slice(0, 16);
    const rel = toPosix(relative(git.root, opts.cwd)) || '.';
    return {
      kind: 'git',
      project_id: `${hash}:${rel}`,
      git_remote: git.remote,
      git_relpath_root: rel,
      repo_root: git.root,
    };
  }

  const marker = tryMarker(opts.cwd, opts.markerFileName ?? DEFAULT_MARKER);
  if (marker) {
    return { kind: 'marker', project_id: marker.uuid, marker_uuid: marker.uuid, marker_path: marker.path };
  }

  return { kind: 'quarantine', project_id: null };
}

function tryGit(cwd: string): { remote: string; root: string } | null {
  const topLevel = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (topLevel.status !== 0) return null;
  const root = topLevel.stdout.trim();
  if (!root) return null;
  const remote = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status !== 0) return null;
  const url = remote.stdout.trim();
  if (!url) return null;
  return { remote: url, root };
}

function tryMarker(cwd: string, fileName: string): { uuid: string; path: string } | null {
  let dir = cwd;
  for (;;) {
    const p = join(dir, fileName);
    if (existsSync(p)) {
      const uuid = readFileSync(p, 'utf8').trim();
      if (uuid) return { uuid, path: p };
    }
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/identity/project-id-git.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity/project-id.ts packages/core/test/identity/project-id-git.test.ts && \
  git commit -m "feat(core): project-id resolver (git case with deterministic hash)"
```

---

### Task 16: Project-id resolver — marker, declared, and quarantine cases

**Files:**
- Create: `packages/core/test/identity/project-id-fallbacks.test.ts`

- [ ] **Step 1: Write `test/identity/project-id-fallbacks.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectId } from '../../src/identity/project-id.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'penumbra-pid-fb-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('declared wins over everything', () => {
  writeFileSync(join(dir, '.penumbra-project'), 'marker-uuid');
  const r = resolveProjectId({ cwd: dir, declaredProjectId: 'declared-xyz' });
  expect(r.kind).toBe('declared');
  if (r.kind === 'declared') expect(r.project_id).toBe('declared-xyz');
});

test('marker file used when no git remote and no declared', () => {
  writeFileSync(join(dir, '.penumbra-project'), 'marker-uuid-42');
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe('marker');
  if (r.kind === 'marker') expect(r.project_id).toBe('marker-uuid-42');
});

test('marker is found by walking up from subdirectory', () => {
  writeFileSync(join(dir, '.penumbra-project'), 'parent-marker');
  const sub = join(dir, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const r = resolveProjectId({ cwd: sub });
  expect(r.kind).toBe('marker');
  if (r.kind === 'marker') expect(r.project_id).toBe('parent-marker');
});

test('quarantine when nothing matches', () => {
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe('quarantine');
  expect(r.project_id).toBeNull();
});
```

- [ ] **Step 2: Run — expect pass**

The implementation is already in place from Task 15. Run:

```bash
bun test packages/core/test/identity/project-id-fallbacks.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/identity/project-id-fallbacks.test.ts && \
  git commit -m "test(core): project-id fallbacks — marker, declared, quarantine"
```

---

### Task 17: Project cache (DB-backed project identity resolution)

**Files:**
- Create: `packages/core/src/identity/project-cache.ts`
- Create: `packages/core/test/identity/project-cache.test.ts`

- [ ] **Step 1: Write `test/identity/project-cache.test.ts`**

```ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { ProjectCache } from '../../src/identity/project-cache.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

test('upsert records a git-kind project on first sight', () => {
  const cache = new ProjectCache({
    db,
    clock: () => new Date('2026-04-23T12:00:00Z'),
  });
  cache.upsertFromResolution(
    { kind: 'git', project_id: 'abc:.', git_remote: 'git@x/y.git', git_relpath_root: '.', repo_root: '/tmp/r' },
    '/tmp/r',
  );
  const row = db
    .query<{ kind: string; git_remote: string }, [string]>(
      'SELECT kind, git_remote FROM projects WHERE project_id=?',
    )
    .get('abc:.');
  expect(row?.kind).toBe('git');
  expect(row?.git_remote).toBe('git@x/y.git');
});

test('upsert appends new path to first_seen_paths without duplicates', () => {
  const cache = new ProjectCache({
    db,
    clock: () => new Date('2026-04-23T12:00:00Z'),
  });
  const res = {
    kind: 'git' as const,
    project_id: 'abc:.',
    git_remote: 'r',
    git_relpath_root: '.',
    repo_root: '/tmp/r',
  };
  cache.upsertFromResolution(res, '/tmp/r');
  cache.upsertFromResolution(res, '/tmp/r');
  cache.upsertFromResolution(res, '/tmp/r-other');
  const row = db
    .query<{ first_seen_paths: string }, [string]>(
      'SELECT first_seen_paths FROM projects WHERE project_id=?',
    )
    .get('abc:.');
  expect(JSON.parse(row!.first_seen_paths)).toEqual(['/tmp/r', '/tmp/r-other']);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/identity/project-cache.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/identity/project-cache.ts`**

```ts
import { Database } from 'bun:sqlite';
import type { Clock } from '../utils/clock.js';
import type { ProjectResolution } from './project-id.js';

export class ProjectCache {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(opts: { db: Database; clock: Clock }) {
    this.db = opts.db;
    this.clock = opts.clock;
  }

  upsertFromResolution(resolution: ProjectResolution, path: string): void {
    if (resolution.kind === 'quarantine') return;
    const existing = this.db
      .query<{ first_seen_paths: string }, [string]>(
        'SELECT first_seen_paths FROM projects WHERE project_id=?',
      )
      .get(resolution.project_id);

    if (existing) {
      const paths: string[] = JSON.parse(existing.first_seen_paths);
      if (!paths.includes(path)) {
        paths.push(path);
        this.db.run('UPDATE projects SET first_seen_paths=? WHERE project_id=?', [
          JSON.stringify(paths),
          resolution.project_id,
        ]);
      }
      return;
    }

    const now = this.clock().toISOString();
    this.db.run(
      `INSERT INTO projects(project_id, kind, git_remote, git_relpath_root, marker_uuid, display_name, first_seen_paths, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolution.project_id,
        resolution.kind,
        resolution.kind === 'git' ? resolution.git_remote : null,
        resolution.kind === 'git' ? resolution.git_relpath_root : null,
        resolution.kind === 'marker' ? resolution.marker_uuid : null,
        null,
        JSON.stringify([path]),
        now,
      ],
    );
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/identity/project-cache.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity/project-cache.ts packages/core/test/identity/project-cache.test.ts && \
  git commit -m "feat(core): ProjectCache — DB-backed identity persistence (pain #2: explicit upsert, no silent create)"
```

---

### Task 18: Observation normalizer (ingest boundary)

**Files:**
- Create: `packages/core/src/normalize/ingest.ts`
- Create: `packages/core/test/normalize/ingest.test.ts`

- [ ] **Step 1: Write `test/normalize/ingest.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { normalize } from '../../src/normalize/ingest.js';
import { DEFAULT_REDACTION_RULES, RegexRedactor } from '../../src/redaction/regex.js';

const redactor = new RegexRedactor(DEFAULT_REDACTION_RULES);
const ctx = {
  userId: 'u-1',
  machineId: 'm-1',
  now: () => new Date('2026-04-23T12:00:00.000Z'),
  uuid: () => 'fixed-uuid',
  redactor,
};

test('fills in event_id, ingest_ts, and default nullables', () => {
  const e = normalize(
    {
      ts: '2026-04-23T11:59:59.000Z',
      source: 'mcp',
      user_id: 'overridden-by-ctx?',
      machine_id: 'overridden-by-ctx?',
      event_type: 'agent-tool-use',
      lane: 'local',
      payload_json: { tool: 'Read', api_key: 'sk-secret' },
    },
    ctx,
  );
  expect(e.event_id).toBe('fixed-uuid');
  expect(e.ingest_ts).toBe('2026-04-23T12:00:00.000Z');
  expect(e.user_id).toBe('u-1');
  expect(e.machine_id).toBe('m-1');
  expect(e.payload_json).toEqual({ tool: 'Read', api_key: '[REDACTED]' });
  expect(e.source_detail).toBeNull();
  expect(e.project_id).toBeNull();
});

test('preserves explicit event_id and ingest_ts when provided', () => {
  const e = normalize(
    {
      event_id: 'explicit',
      ingest_ts: '2026-04-23T12:05:00.000Z',
      ts: '2026-04-23T11:59:59.000Z',
      source: 'mcp',
      user_id: 'x',
      machine_id: 'x',
      event_type: 'agent-prompt',
      lane: 'local',
      payload_json: {},
    },
    ctx,
  );
  expect(e.event_id).toBe('explicit');
  expect(e.ingest_ts).toBe('2026-04-23T12:05:00.000Z');
});

test('strips privacy-tagged text from payload_summary', () => {
  const e = normalize(
    {
      ts: '2026-04-23T11:59:59.000Z',
      source: 'mcp',
      user_id: 'x',
      machine_id: 'x',
      event_type: 'agent-prompt',
      lane: 'local',
      payload_json: { prompt: 'keep <private>secret</private> done' },
      payload_summary: 'keep <private>secret</private> done',
    },
    ctx,
  );
  expect(e.payload_summary).toBe('keep  done');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/normalize/ingest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/normalize/ingest.ts`**

```ts
import type { Clock } from '../utils/clock.js';
import type { Uuid } from '../utils/uuid.js';
import type { RegexRedactor } from '../redaction/regex.js';
import { stripPrivacyTags } from '../redaction/privacy-tags.js';
import { T0EventInputSchema, T0EventSchema, type T0Event, type T0EventInput } from '../schemas/event.js';

export interface NormalizeCtx {
  userId: string;
  machineId: string;
  now: Clock;
  uuid: Uuid;
  redactor: RegexRedactor;
}

export function normalize(input: T0EventInput, ctx: NormalizeCtx): T0Event {
  const validated = T0EventInputSchema.parse(input);
  const redactedPayload = ctx.redactor.redact(validated.payload_json) as Record<string, unknown>;
  const summary = validated.payload_summary === undefined || validated.payload_summary === null
    ? null
    : stripPrivacyTags(validated.payload_summary);

  const event: T0Event = {
    event_id: validated.event_id ?? ctx.uuid(),
    ts: validated.ts,
    ingest_ts: validated.ingest_ts ?? ctx.now().toISOString(),
    source: validated.source,
    source_detail: validated.source_detail ?? null,
    project_id: validated.project_id ?? null,
    user_id: ctx.userId,
    machine_id: ctx.machineId,
    session_id: validated.session_id ?? null,
    event_type: validated.event_type,
    lane: validated.lane,
    provider: validated.provider ?? null,
    model: validated.model ?? null,
    tokens_in: validated.tokens_in ?? null,
    tokens_out: validated.tokens_out ?? null,
    cost_usd: validated.cost_usd ?? null,
    latency_ms: validated.latency_ms ?? null,
    request_id: validated.request_id ?? null,
    payload_json: redactedPayload,
    payload_summary: summary,
  };
  return T0EventSchema.parse(event);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/normalize/ingest.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/normalize packages/core/test/normalize && \
  git commit -m "feat(core): ingest normalizer — redact+strip+validate at the boundary"
```

---

### Task 19: T0 writer (SQLite insert, uses normalizer output)

**Files:**
- Create: `packages/core/src/writers/t0.ts`
- Create: `packages/core/test/writers/t0.test.ts`

- [ ] **Step 1: Write `test/writers/t0.test.ts`**

```ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { T0Writer } from '../../src/writers/t0.js';
import { T0EventSchema } from '../../src/schemas/event.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

const sample = T0EventSchema.parse({
  event_id: 'e1',
  ts: '2026-04-23T11:59:59.000Z',
  ingest_ts: '2026-04-23T12:00:00.000Z',
  source: 'mcp',
  source_detail: 'claude-code',
  project_id: null,
  user_id: 'u',
  machine_id: 'm',
  session_id: 's',
  event_type: 'agent-tool-use',
  lane: 'local',
  provider: null,
  model: null,
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  latency_ms: null,
  request_id: null,
  payload_json: { tool: 'Read' },
  payload_summary: 'Read src/x.ts',
});

test('writes a row and is retrievable', () => {
  const w = new T0Writer(db);
  w.write(sample);
  const row = db
    .query<{ event_id: string; payload_json: string }, [string]>(
      'SELECT event_id, payload_json FROM t0_events WHERE event_id=?',
    )
    .get('e1');
  expect(row?.event_id).toBe('e1');
  expect(JSON.parse(row!.payload_json)).toEqual({ tool: 'Read' });
});

test('insert of duplicate event_id fails loud', () => {
  const w = new T0Writer(db);
  w.write(sample);
  expect(() => w.write(sample)).toThrow();
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/writers/t0.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/writers/t0.ts`**

```ts
import { Database } from 'bun:sqlite';
import type { T0Event } from '../schemas/event.js';

export class T0Writer {
  private readonly insert;

  constructor(db: Database) {
    this.insert = db.prepare(`
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, source_detail, project_id,
        user_id, machine_id, session_id, event_type, lane,
        provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `);
  }

  write(e: T0Event): void {
    this.insert.run(
      e.event_id, e.ts, e.ingest_ts, e.source, e.source_detail, e.project_id,
      e.user_id, e.machine_id, e.session_id, e.event_type, e.lane,
      e.provider, e.model, e.tokens_in, e.tokens_out, e.cost_usd, e.latency_ms,
      e.request_id, JSON.stringify(e.payload_json), e.payload_summary,
    );
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/writers/t0.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/writers packages/core/test/writers && \
  git commit -m "feat(core): T0Writer — prepared-statement insert, fails on duplicate event_id"
```

---

## Sprint D — Embedder abstraction and recall (Tasks 20–24)

### Task 20: Embedder interface + TestEmbedder

**Files:**
- Create: `packages/core/src/embedder/interface.ts`
- Create: `packages/core/src/embedder/test-embedder.ts`
- Create: `packages/core/test/embedder/test-embedder.test.ts`

- [ ] **Step 1: Write `test/embedder/test-embedder.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { TestEmbedder } from '../../src/embedder/test-embedder.js';

test('TestEmbedder returns stable vectors for the same input', async () => {
  const e = new TestEmbedder({ dim: 384 });
  const a = await e.embed(['hello']);
  const b = await e.embed(['hello']);
  expect(a[0]!.length).toBe(384);
  expect(Array.from(a[0]!)).toEqual(Array.from(b[0]!));
});

test('TestEmbedder returns different vectors for different inputs', async () => {
  const e = new TestEmbedder({ dim: 384 });
  const [a, b] = await e.embed(['hello', 'world']);
  const same = Array.from(a!).every((v, i) => v === b![i]);
  expect(same).toBe(false);
});

test('dim is reflected by the embedder', () => {
  const e = new TestEmbedder({ dim: 128 });
  expect(e.dim).toBe(128);
  expect(e.name).toBe('test');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/embedder/test-embedder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/embedder/interface.ts`**

```ts
export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

- [ ] **Step 4: Write `src/embedder/test-embedder.ts`**

```ts
import { createHash } from 'node:crypto';
import type { Embedder } from './interface.js';

export class TestEmbedder implements Embedder {
  readonly name = 'test';
  readonly dim: number;

  constructor(opts: { dim: number }) {
    this.dim = opts.dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.hashToVector(t));
  }

  private hashToVector(text: string): Float32Array {
    const out = new Float32Array(this.dim);
    // Use repeated SHA256 rounds to fill the vector deterministically.
    let buf = Buffer.from(text, 'utf8');
    let i = 0;
    while (i < this.dim) {
      buf = createHash('sha256').update(buf).digest();
      for (let j = 0; j < buf.length && i < this.dim; j += 4) {
        const v = buf.readUInt32BE(j) / 0xffffffff; // 0..1
        out[i++] = v * 2 - 1; // -1..1
      }
    }
    // L2-normalize (so cosine sim == dot product later).
    let norm = 0;
    for (let k = 0; k < out.length; k++) norm += out[k]! * out[k]!;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < out.length; k++) out[k] = out[k]! / norm;
    return out;
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/core/test/embedder/test-embedder.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/embedder packages/core/test/embedder && \
  git commit -m "feat(core): Embedder interface + TestEmbedder (deterministic for unit tests)"
```

---

### Task 21: Bundled ONNX embedder via fastembed

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/embedder/bundled.ts`
- Create: `packages/core/test/embedder/bundled.test.ts`

- [ ] **Step 1: Add `fastembed` to `packages/core/package.json`**

Under `dependencies`:

```json
"fastembed": "^1.14.1"
```

Then `bun install` from the repo root.

- [ ] **Step 2: Write `test/embedder/bundled.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { BundledEmbedder } from '../../src/embedder/bundled.js';

// Skip if the env flag opt-out is set — CI without net access.
const SKIP = process.env.PENUMBRA_SKIP_ONNX === '1';

const maybeTest = SKIP ? test.skip : test;

maybeTest('BundledEmbedder loads the model and returns 384-dim vectors', async () => {
  const e = new BundledEmbedder();
  await e.ready();
  const v = await e.embed(['hello world']);
  expect(e.dim).toBe(384);
  expect(v[0]!.length).toBe(384);
  expect(e.name).toBe('fastembed-minilm-l6-v2');
});

maybeTest('BundledEmbedder vectors are deterministic for the same input', async () => {
  const e = new BundledEmbedder();
  await e.ready();
  const a = await e.embed(['hello']);
  const b = await e.embed(['hello']);
  expect(Array.from(a[0]!.slice(0, 8))).toEqual(Array.from(b[0]!.slice(0, 8)));
});
```

- [ ] **Step 3: Run — expect fail**

Run: `bun test packages/core/test/embedder/bundled.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/embedder/bundled.ts`**

```ts
import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import type { Embedder } from './interface.js';

export class BundledEmbedder implements Embedder {
  readonly name = 'fastembed-minilm-l6-v2';
  readonly dim = 384;
  private model: FlagEmbedding | null = null;

  async ready(): Promise<void> {
    if (this.model) return;
    this.model = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2,
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    await this.ready();
    const out: Float32Array[] = [];
    for await (const batch of this.model!.embed(texts, texts.length)) {
      for (const v of batch) out.push(new Float32Array(v));
    }
    return out;
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/core/test/embedder/bundled.test.ts`
Expected: 2 tests pass (model downloads on first run; ~80MB).

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/embedder/bundled.ts packages/core/test/embedder/bundled.test.ts bun.lockb && \
  git commit -m "feat(core): bundled ONNX embedder (fastembed MiniLM-L6-v2, 384-dim)"
```

---

### Task 22: Sirius HTTP embedder adapter

**Files:**
- Create: `packages/core/src/embedder/sirius.ts`
- Create: `packages/core/test/embedder/sirius.test.ts`

- [ ] **Step 1: Write `test/embedder/sirius.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { SiriusEmbedder } from '../../src/embedder/sirius.js';

test('POSTs to /v1/embeddings and parses the OpenAI-compat response', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      expect(new URL(req.url).pathname).toBe('/v1/embeddings');
      expect(req.headers.get('authorization')).toBe('Bearer test-token');
      const body = (await req.json()) as { input: string[] };
      const vectors = body.input.map((_, i) => Array.from({ length: 4 }, (_, j) => i + j));
      return Response.json({
        data: vectors.map((v, i) => ({ embedding: v, index: i, object: 'embedding' })),
      });
    },
  });

  const e = new SiriusEmbedder({
    baseUrl: `http://localhost:${server.port}`,
    token: 'test-token',
    model: 'bge-small',
    dim: 4,
  });
  const out = await e.embed(['a', 'b']);
  expect(out.length).toBe(2);
  expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
  expect(Array.from(out[1]!)).toEqual([1, 2, 3, 4]);
  server.stop(true);
});

test('throws on non-2xx', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
  const e = new SiriusEmbedder({
    baseUrl: `http://localhost:${server.port}`,
    token: 't', model: 'm', dim: 4,
  });
  await expect(e.embed(['x'])).rejects.toThrow(/sirius embeddings/);
  server.stop(true);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/embedder/sirius.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/embedder/sirius.ts`**

```ts
import type { Embedder } from './interface.js';

export interface SiriusEmbedderOpts {
  baseUrl: string;
  token: string;
  model: string;
  dim: number;
}

export class SiriusEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly model: string;

  constructor(opts: SiriusEmbedderOpts) {
    this.name = `sirius:${opts.model}`;
    this.dim = opts.dim;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.model = opts.model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });
    if (!res.ok) {
      throw new Error(`sirius embeddings: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/embedder/sirius.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/embedder/sirius.ts packages/core/test/embedder/sirius.test.ts && \
  git commit -m "feat(core): SiriusEmbedder — HTTP adapter against /v1/embeddings"
```

---

### Task 23: Embedder resolver (picks sirius when available, else bundled)

**Files:**
- Create: `packages/core/src/embedder/resolve.ts`
- Create: `packages/core/test/embedder/resolve.test.ts`

- [ ] **Step 1: Write `test/embedder/resolve.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { resolveEmbedder } from '../../src/embedder/resolve.js';
import { TestEmbedder } from '../../src/embedder/test-embedder.js';

test('returns sirius when reachable and preferSirius is true', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') return new Response('ok');
      return Response.json({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] });
    },
  });

  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    preferSirius: true,
    sirius: { baseUrl: `http://localhost:${server.port}`, token: 't', model: 'm', dim: 4 },
    fallback,
  });
  expect(e.name).toBe('sirius:m');
  server.stop(true);
});

test('returns fallback when sirius is unreachable', async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({
    preferSirius: true,
    sirius: { baseUrl: 'http://127.0.0.1:1', token: 't', model: 'm', dim: 4 },
    fallback,
  });
  expect(e.name).toBe('test');
});

test('preferSirius=false always returns fallback', async () => {
  const fallback = new TestEmbedder({ dim: 4 });
  const e = await resolveEmbedder({ preferSirius: false, fallback });
  expect(e.name).toBe('test');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/embedder/resolve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/embedder/resolve.ts`**

```ts
import type { Embedder } from './interface.js';
import { SiriusEmbedder, type SiriusEmbedderOpts } from './sirius.js';

export interface ResolveOpts {
  preferSirius: boolean;
  sirius?: SiriusEmbedderOpts;
  fallback: Embedder;
  healthTimeoutMs?: number;
}

export async function resolveEmbedder(opts: ResolveOpts): Promise<Embedder> {
  if (!opts.preferSirius || !opts.sirius) return opts.fallback;

  const timeout = opts.healthTimeoutMs ?? 500;
  const reachable = await siriusReachable(opts.sirius.baseUrl, timeout);
  if (!reachable) return opts.fallback;
  return new SiriusEmbedder(opts.sirius);
}

async function siriusReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/healthz`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/embedder/resolve.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/embedder/resolve.ts packages/core/test/embedder/resolve.test.ts && \
  git commit -m "feat(core): resolveEmbedder — layered sirius→bundled fallback with health probe"
```

---

### Task 24: Recall query builder (semantic + recency rank over T1+T2)

**Files:**
- Create: `packages/core/src/readers/recall.ts`
- Create: `packages/core/test/readers/recall.test.ts`

- [ ] **Step 1: Write `test/readers/recall.test.ts`**

```ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { TestEmbedder } from '../../src/embedder/test-embedder.js';
import { RecallReader } from '../../src/readers/recall.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

async function seedT1(rollupId: string, text: string, createdAt: string) {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([text]);
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                            n_events, last_response_excerpt, first_prompt_excerpt)
     VALUES (?, ?, 'u', ?, ?, ?, 1, ?, ?)`,
    [rollupId, 'p1', rollupId, createdAt, createdAt, text, text],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>('SELECT rowid FROM t1_rollups WHERE rollup_id=?')
    .get(rollupId)!.rowid;
  db.run('INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)', [rowid, vec!.buffer]);
}

test('returns T1 rollups ranked by vector similarity', async () => {
  await seedT1('a', 'the quick brown fox', '2026-04-20T00:00:00Z');
  await seedT1('b', 'penguins march in the antarctic', '2026-04-21T00:00:00Z');

  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'the quick brown fox',
    project_id: 'p1',
    limit: 10,
    include_raw: false,
    min_score: 0,
  });
  expect(results[0]!.id).toBe('a');
  expect(results[0]!.tier).toBe('t1');
});

test('honors project_id filter', async () => {
  await seedT1('a', 'x', '2026-04-20T00:00:00Z');
  db.run("UPDATE t1_rollups SET project_id='other' WHERE rollup_id='a'");
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'x', project_id: 'p1', limit: 10, include_raw: false, min_score: 0,
  });
  expect(results.length).toBe(0);
});

test('empty DB returns empty array', async () => {
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'x', project_id: null, limit: 10, include_raw: false, min_score: 0,
  });
  expect(results).toEqual([]);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/readers/recall.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/readers/recall.ts`**

```ts
import { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import type { RecallRequest, RecallResult } from '../schemas/recall.js';

export class RecallReader {
  private readonly db: Database;
  private readonly embedder: Embedder;

  constructor(opts: { db: Database; embedder: Embedder }) {
    this.db = opts.db;
    this.embedder = opts.embedder;
  }

  async recall(req: RecallRequest): Promise<RecallResult[]> {
    const [qvec] = await this.embedder.embed([req.query]);
    const qbuf = qvec!.buffer;

    type T1Row = {
      rollup_id: string;
      project_id: string | null;
      session_id: string;
      started_at: string;
      first_prompt_excerpt: string | null;
      last_response_excerpt: string | null;
      distance: number;
    };
    const t1Rows = this.db
      .query<T1Row, [ArrayBuffer, string | null, number]>(
        `SELECT r.rollup_id, r.project_id, r.session_id, r.started_at,
                r.first_prompt_excerpt, r.last_response_excerpt,
                v.distance
           FROM t1_vec v
           JOIN t1_rollups r ON r.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = ?
            AND (? IS NULL OR r.project_id = ?)
          ORDER BY v.distance ASC`,
      )
      .all(qbuf, req.project_id, req.limit);

    const t1 = t1Rows
      .map((r): RecallResult => ({
        id: r.rollup_id,
        tier: 't1',
        score: toScore(r.distance),
        title: null,
        body: [r.first_prompt_excerpt, r.last_response_excerpt].filter(Boolean).join('\n\n'),
        project_id: r.project_id,
        source_session_ids: [r.session_id],
        created_at: r.started_at,
      }))
      .filter((r) => r.score >= req.min_score);

    type T2Row = {
      memory_id: string;
      project_id: string | null;
      title: string;
      body: string;
      created_at: string;
      source_session_ids: string;
      distance: number;
    };
    const t2Rows = this.db
      .query<T2Row, [ArrayBuffer, string | null, number]>(
        `SELECT m.memory_id, m.project_id, m.title, m.body, m.created_at, m.source_session_ids,
                v.distance
           FROM t2_vec v
           JOIN t2_memories m ON m.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = ?
            AND (? IS NULL OR m.project_id = ?)
          ORDER BY v.distance ASC`,
      )
      .all(qbuf, req.project_id, req.limit);

    const t2 = t2Rows
      .map((r): RecallResult => ({
        id: r.memory_id,
        tier: 't2',
        score: toScore(r.distance),
        title: r.title,
        body: r.body,
        project_id: r.project_id,
        source_session_ids: JSON.parse(r.source_session_ids),
        created_at: r.created_at,
      }))
      .filter((r) => r.score >= req.min_score);

    return [...t1, ...t2]
      .sort((a, b) => b.score - a.score)
      .slice(0, req.limit);
  }
}

function toScore(distance: number): number {
  // sqlite-vec returns L2 distance on normalized vectors in [0, 2].
  // Convert to a [0, 1]-ish similarity: 1 - distance/2.
  return Math.max(0, Math.min(1, 1 - distance / 2));
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/readers/recall.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/readers packages/core/test/readers && \
  git commit -m "feat(core): RecallReader — combined T1+T2 vector search with project filter"
```

---

## Sprint E — PID registry, supervisor, scheduler, services, daemon HTTP (Tasks 25–33)

### Task 25: PID registry with real liveness checks (pain #6)

**Files:**
- Create: `packages/core/src/pid/registry.ts`
- Create: `packages/core/test/pid/registry.test.ts`

- [ ] **Step 1: Write `test/pid/registry.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { PidRegistry } from '../../src/pid/registry.js';

test('register and iterate live PIDs', () => {
  const reg = new PidRegistry({ softCap: 2, hardCap: 4 });
  reg.register({ pid: process.pid, name: 'self', startedAt: new Date() });
  const live = reg.live();
  expect(live.some((e) => e.pid === process.pid)).toBe(true);
});

test('reap drops entries whose PID is dead', () => {
  const reg = new PidRegistry({ softCap: 2, hardCap: 4 });
  // 999999 is almost certainly not a live PID.
  reg.register({ pid: 999999, name: 'fake', startedAt: new Date() });
  const reaped = reg.reap();
  expect(reaped.length).toBe(1);
  expect(reg.live().some((e) => e.pid === 999999)).toBe(false);
});

test('over hardCap throws', () => {
  const reg = new PidRegistry({ softCap: 1, hardCap: 2 });
  reg.register({ pid: process.pid, name: 'a', startedAt: new Date() });
  reg.register({ pid: process.pid, name: 'b', startedAt: new Date() });
  expect(() =>
    reg.register({ pid: process.pid, name: 'c', startedAt: new Date() }),
  ).toThrow(/hardCap/);
});

test('over softCap returns a warning but succeeds', () => {
  const reg = new PidRegistry({ softCap: 1, hardCap: 4 });
  reg.register({ pid: process.pid, name: 'a', startedAt: new Date() });
  const warn = reg.register({ pid: process.pid, name: 'b', startedAt: new Date() });
  expect(warn).toMatch(/softCap/);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/pid/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/pid/registry.ts`**

```ts
export interface PidEntry {
  pid: number;
  name: string;
  startedAt: Date;
}

export interface PidRegistryOpts {
  softCap: number;
  hardCap: number;
}

export class PidRegistry {
  private entries: PidEntry[] = [];
  constructor(private readonly caps: PidRegistryOpts) {}

  register(e: PidEntry): string | null {
    if (this.entries.length >= this.caps.hardCap) {
      throw new Error(`PidRegistry hardCap=${this.caps.hardCap} reached`);
    }
    this.entries.push(e);
    if (this.entries.length > this.caps.softCap) {
      return `over softCap=${this.caps.softCap}, ${this.entries.length} active`;
    }
    return null;
  }

  live(): PidEntry[] {
    return this.entries.filter((e) => isAlive(e.pid));
  }

  reap(): PidEntry[] {
    const dead: PidEntry[] = [];
    this.entries = this.entries.filter((e) => {
      if (isAlive(e.pid)) return true;
      dead.push(e);
      return false;
    });
    return dead;
  }

  unregister(pid: number): void {
    this.entries = this.entries.filter((e) => e.pid !== pid);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/pid/registry.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pid packages/core/test/pid && \
  git commit -m "feat(core): PidRegistry with kill(pid,0) liveness + soft/hard caps (pain #6)"
```

---

### Task 26: WorkerSupervisor interface + in-process implementation

**Files:**
- Create: `packages/core/src/supervisor/interface.ts`
- Create: `packages/core/src/supervisor/in-process.ts`
- Create: `packages/core/test/supervisor/in-process.test.ts`

- [ ] **Step 1: Write `test/supervisor/in-process.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { InProcessSupervisor } from '../../src/supervisor/in-process.js';

test('start runs the tick function then reports running', async () => {
  const sup = new InProcessSupervisor();
  let count = 0;
  sup.register({
    name: 'w',
    intervalMs: 1_000,
    tick: async () => { count++; },
  });
  await sup.startAll();
  expect(sup.status('w')).toBe('running');
  await Bun.sleep(5); // let the initial tick run
  expect(count).toBeGreaterThanOrEqual(1);
  sup.stopAll();
});

test('stopAll stops ticks and reports stopped', async () => {
  const sup = new InProcessSupervisor();
  let count = 0;
  sup.register({ name: 'w', intervalMs: 1_000, tick: async () => { count++; } });
  await sup.startAll();
  sup.stopAll();
  expect(sup.status('w')).toBe('stopped');
});

test('thrown tick errors are caught; next tick still runs', async () => {
  const sup = new InProcessSupervisor();
  let throws = true;
  let ran = 0;
  sup.register({
    name: 'w', intervalMs: 5,
    tick: async () => {
      ran++;
      if (throws) { throws = false; throw new Error('boom'); }
    },
  });
  await sup.startAll();
  await Bun.sleep(30);
  sup.stopAll();
  expect(ran).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/supervisor/in-process.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/supervisor/interface.ts`**

```ts
export type WorkerStatus = 'idle' | 'running' | 'stopped' | 'errored';

export interface WorkerDef {
  name: string;
  intervalMs: number;
  tick: () => Promise<void>;
}

export interface WorkerSupervisor {
  register(def: WorkerDef): void;
  startAll(): Promise<void>;
  stopAll(): void;
  status(name: string): WorkerStatus;
  runOnceNow(name: string): Promise<void>;
}
```

- [ ] **Step 4: Write `src/supervisor/in-process.ts`**

```ts
import type { WorkerDef, WorkerStatus, WorkerSupervisor } from './interface.js';

interface Slot {
  def: WorkerDef;
  status: WorkerStatus;
  timer: Timer | null;
}

export class InProcessSupervisor implements WorkerSupervisor {
  private slots = new Map<string, Slot>();

  register(def: WorkerDef): void {
    this.slots.set(def.name, { def, status: 'idle', timer: null });
  }

  async startAll(): Promise<void> {
    for (const slot of this.slots.values()) {
      await this.runTick(slot);
      slot.timer = setInterval(() => { void this.runTick(slot); }, slot.def.intervalMs);
      slot.status = 'running';
    }
  }

  stopAll(): void {
    for (const slot of this.slots.values()) {
      if (slot.timer) clearInterval(slot.timer);
      slot.timer = null;
      slot.status = 'stopped';
    }
  }

  status(name: string): WorkerStatus {
    return this.slots.get(name)?.status ?? 'idle';
  }

  async runOnceNow(name: string): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`unknown worker ${name}`);
    await this.runTick(slot);
  }

  private async runTick(slot: Slot): Promise<void> {
    try {
      await slot.def.tick();
      if (slot.status !== 'stopped') slot.status = 'running';
    } catch {
      slot.status = 'errored';
    }
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/core/test/supervisor/in-process.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/supervisor packages/core/test/supervisor && \
  git commit -m "feat(core): WorkerSupervisor interface + in-process impl (C-compat abstraction)"
```

---

### Task 27: Services container (DI — pain #3)

**Files:**
- Create: `packages/core/src/services.ts`
- Create: `packages/core/test/services.test.ts`

- [ ] **Step 1: Write `test/services.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVec } from '../src/db/sqlite-vec.js';
import { migrate } from '../src/db/migrations.js';
import { buildServices } from '../src/services.js';
import { TestEmbedder } from '../src/embedder/test-embedder.js';

test('buildServices wires all core dependencies with injected clock/uuid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-svc-'));
  try {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const svc = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => new Date('2026-04-23T00:00:00Z'),
      uuid: () => 'u',
    });
    expect(svc.settings.t0RetentionDays).toBe(14);
    expect(svc.machineId.get()).toBe('u');
    expect(svc.redactor).toBeDefined();
    expect(svc.t0Writer).toBeDefined();
    expect(svc.recallReader).toBeDefined();
    expect(svc.supervisor).toBeDefined();
    expect(svc.projectCache).toBeDefined();
    expect(svc.pidRegistry).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/services.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/services.ts`**

```ts
import { Database } from 'bun:sqlite';
import { type Settings, type SettingsInput, SettingsDefaults } from './settings.js';
import { MachineId } from './identity/machine-id.js';
import { ProjectCache } from './identity/project-cache.js';
import { DbMeta } from './db/meta.js';
import { DEFAULT_REDACTION_RULES, RegexRedactor } from './redaction/regex.js';
import { T0Writer } from './writers/t0.js';
import { RecallReader } from './readers/recall.js';
import { InProcessSupervisor } from './supervisor/in-process.js';
import { PidRegistry } from './pid/registry.js';
import { systemClock, type Clock } from './utils/clock.js';
import { systemUuid, type Uuid } from './utils/uuid.js';
import type { Embedder } from './embedder/interface.js';
import { createLogger, type Logger } from './logger.js';

export interface Services {
  settings: Settings;
  storageRoot: string;
  db: Database;
  dbMeta: DbMeta;
  machineId: MachineId;
  projectCache: ProjectCache;
  redactor: RegexRedactor;
  t0Writer: T0Writer;
  recallReader: RecallReader;
  supervisor: InProcessSupervisor;
  pidRegistry: PidRegistry;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
  log: Logger;
}

export interface BuildServicesOpts {
  env: NodeJS.ProcessEnv;
  input: SettingsInput;
  storageRoot: string;
  db: Database;
  embedder: Embedder;
  clock?: Clock;
  uuid?: Uuid;
  softPidCap?: number;
  hardPidCap?: number;
}

export function buildServices(opts: BuildServicesOpts): Services {
  const settings = SettingsDefaults.build({ env: opts.env, input: opts.input });
  const clock = opts.clock ?? systemClock;
  const uuid = opts.uuid ?? systemUuid;
  const machineId = new MachineId({ storageRoot: opts.storageRoot, uuid });
  return {
    settings,
    storageRoot: opts.storageRoot,
    db: opts.db,
    dbMeta: new DbMeta(opts.db),
    machineId,
    projectCache: new ProjectCache({ db: opts.db, clock }),
    redactor: new RegexRedactor(DEFAULT_REDACTION_RULES),
    t0Writer: new T0Writer(opts.db),
    recallReader: new RecallReader({ db: opts.db, embedder: opts.embedder }),
    supervisor: new InProcessSupervisor(),
    pidRegistry: new PidRegistry({
      softCap: opts.softPidCap ?? 8,
      hardCap: opts.hardPidCap ?? 16,
    }),
    embedder: opts.embedder,
    clock,
    uuid,
    log: createLogger({ component: 'penumbra' }),
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/core/test/services.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services.ts packages/core/test/services.test.ts && \
  git commit -m "feat(core): Services container (constructor-injected, no import-time singletons — pain #3)"
```

---

### Task 28: Scaffold the `daemon` package

**Files:**
- Create: `packages/daemon/package.json`
- Create: `packages/daemon/tsconfig.json`
- Create: `packages/daemon/src/index.ts`
- Create: `packages/daemon/test/sanity.test.ts`

- [ ] **Step 1: Write `packages/daemon/package.json`**

```json
{
  "name": "@penumbra/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@penumbra/core": "workspace:*",
    "zod": "^4.3.0"
  }
}
```

- [ ] **Step 2: Write `packages/daemon/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: Write `test/sanity.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { Branding } from '@penumbra/core';

test('daemon package can import @penumbra/core', () => {
  expect(Branding.slug).toBe('penumbra');
});
```

- [ ] **Step 5: Install + run**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install && bun test packages/daemon
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon tsconfig.json bun.lockb && \
  git commit -m "chore(daemon): scaffold @penumbra/daemon package"
```

---

### Task 29: Bearer auth middleware

**Files:**
- Create: `packages/daemon/src/auth.ts`
- Create: `packages/daemon/test/auth.test.ts`

- [ ] **Step 1: Write `test/auth.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { createBearerAuth } from '../src/auth.js';

test('returns 401 when no Authorization header', async () => {
  const auth = createBearerAuth({ token: 'secret' });
  const req = new Request('http://x/test');
  const denied = auth(req);
  expect(denied?.status).toBe(401);
});

test('returns 401 when token mismatches', async () => {
  const auth = createBearerAuth({ token: 'secret' });
  const req = new Request('http://x/test', {
    headers: { authorization: 'Bearer wrong' },
  });
  const denied = auth(req);
  expect(denied?.status).toBe(401);
});

test('returns null when token matches', async () => {
  const auth = createBearerAuth({ token: 'secret' });
  const req = new Request('http://x/test', {
    headers: { authorization: 'Bearer secret' },
  });
  expect(auth(req)).toBeNull();
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/daemon/test/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/auth.ts`**

```ts
export interface AuthOpts { token: string }

export function createBearerAuth(opts: AuthOpts): (req: Request) => Response | null {
  const expected = `Bearer ${opts.token}`;
  return (req) => {
    const header = req.headers.get('authorization');
    if (header !== expected) {
      return new Response(JSON.stringify({ code: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return null;
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/daemon/test/auth.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/auth.ts packages/daemon/test/auth.test.ts && \
  git commit -m "feat(daemon): bearer-auth middleware (C-compat — works over any transport)"
```

---

### Task 30: Daemon HTTP server scaffold + `/health` route

**Files:**
- Create: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/src/routes/health.ts`
- Create: `packages/daemon/test/helpers.ts`
- Create: `packages/daemon/test/health.test.ts`

- [ ] **Step 1: Write `test/helpers.ts`**

```ts
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServices, loadSqliteVec, migrate, TestEmbedder, type Services,
} from '@penumbra/core';
import { serve, type DaemonHandle } from '../src/serve.js';

export interface TempDaemon {
  services: Services;
  handle: DaemonHandle;
  url: string;
  token: string;
  dir: string;
  stop(): void;
}

export function makeTempDaemon(opts: { token?: string } = {}): TempDaemon {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-daemon-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: dir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:00:00Z'),
    uuid: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
  });
  const token = opts.token ?? 'test-token';
  const handle = serve({ services, token, port: 0 });
  return {
    services, handle, token,
    url: `http://localhost:${handle.port}`,
    dir,
    stop() {
      handle.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Write `test/health.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('GET /health returns 200', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeDefined();
  } finally {
    d.stop();
  }
});

test('GET /health needs no auth', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
  } finally {
    d.stop();
  }
});

test('GET /other returns 401 without token', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, { method: 'POST' });
    expect(res.status).toBe(401);
  } finally {
    d.stop();
  }
});
```

- [ ] **Step 3: Run — expect fail**

Run: `bun test packages/daemon/test/health.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/routes/health.ts`**

```ts
export function healthRoute(): Response {
  return Response.json({ status: 'ok', version: '0.0.0' });
}
```

- [ ] **Step 5: Write `src/serve.ts`**

```ts
import type { Services } from '@penumbra/core';
import { createBearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';

export interface ServeOpts {
  services: Services;
  token: string;
  port: number;
}

export interface DaemonHandle {
  port: number;
  stop(): void;
}

export function serve(opts: ServeOpts): DaemonHandle {
  const auth = createBearerAuth({ token: opts.token });
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return healthRoute();
      const denied = auth(req);
      if (denied) return denied;
      return new Response('not found', { status: 404 });
    },
  });
  opts.services.log.info({ port: server.port }, 'daemon started');
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
```

- [ ] **Step 6: Run — expect pass**

Run: `bun test packages/daemon/test/health.test.ts`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src packages/daemon/test/helpers.ts packages/daemon/test/health.test.ts && \
  git commit -m "feat(daemon): Bun.serve scaffold + /health + bearer-gated other routes"
```

---

### Task 31: POST /observations route

**Files:**
- Create: `packages/daemon/src/routes/observations.ts`
- Modify: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/test/observations.test.ts`

- [ ] **Step 1: Write `test/observations.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('POST /observations writes a T0 row and returns event_id', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ts: '2026-04-23T11:59:59Z',
        source: 'mcp',
        source_detail: 'claude-code',
        session_id: 's1',
        event_type: 'agent-prompt',
        lane: 'local',
        payload_json: { prompt: 'hi' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_id).toBeDefined();
    const count = d.services.db
      .query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get();
    expect(count?.c).toBe(1);
  } finally { d.stop(); }
});

test('POST /observations returns 400 on Zod failure', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ts: 'x', source: 'bogus', payload_json: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('validation_error');
  } finally { d.stop(); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/daemon/test/observations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/routes/observations.ts`**

```ts
import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { normalize, T0EventInputSchema } from '@penumbra/core';

export async function observationsRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (!raw) {
    return json({ code: 'invalid_json' }, 400);
  }
  const parsed = T0EventInputSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      code: 'validation_error',
      message: 'body failed schema validation',
      field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    }, 400);
  }
  const ctx = {
    userId: services.machineId.get(),
    machineId: services.machineId.get(),
    now: services.clock,
    uuid: services.uuid,
    redactor: services.redactor,
  };
  const event = normalize(parsed.data, ctx);
  services.t0Writer.write(event);
  return json({ event_id: event.event_id });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 4: Re-export `normalize` and `T0EventInputSchema` from `@penumbra/core`**

Modify `packages/core/src/index.ts` to add:

```ts
export { normalize, type NormalizeCtx } from './normalize/ingest.js';
export {
  T0EventSchema, T0EventInputSchema, type T0Event, type T0EventInput,
} from './schemas/event.js';
export { buildServices, type Services, type BuildServicesOpts } from './services.js';
export { loadSqliteVec } from './db/sqlite-vec.js';
export { migrate } from './db/migrations.js';
export { TestEmbedder } from './embedder/test-embedder.js';
export { BundledEmbedder } from './embedder/bundled.js';
export { SiriusEmbedder } from './embedder/sirius.js';
export { resolveEmbedder } from './embedder/resolve.js';
export { RecallRequestSchema, RecallResultSchema, type RecallRequest, type RecallResult } from './schemas/recall.js';
```

- [ ] **Step 5: Modify `src/serve.ts` to route observations**

Replace the inline dispatch with:

```ts
import type { Services } from '@penumbra/core';
import { createBearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { observationsRoute } from './routes/observations.js';

export interface ServeOpts {
  services: Services;
  token: string;
  port: number;
}

export interface DaemonHandle {
  port: number;
  stop(): void;
}

export function serve(opts: ServeOpts): DaemonHandle {
  const auth = createBearerAuth({ token: opts.token });
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return healthRoute();
      const denied = auth(req);
      if (denied) return denied;
      if (req.method === 'POST' && url.pathname === '/observations') {
        return observationsRoute(req, opts.services);
      }
      return new Response('not found', { status: 404 });
    },
  });
  opts.services.log.info({ port: server.port }, 'daemon started');
  return { port: server.port, stop: () => server.stop(true) };
}
```

- [ ] **Step 6: Run — expect pass**

Run: `bun test packages/daemon/test/observations.test.ts`
Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src packages/core/src/index.ts packages/daemon/test/observations.test.ts && \
  git commit -m "feat(daemon): POST /observations — normalize+write+return event_id"
```

---

### Task 32: POST /recall route

**Files:**
- Create: `packages/daemon/src/routes/recall.ts`
- Modify: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/test/recall.test.ts`

- [ ] **Step 1: Write `test/recall.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('POST /recall returns empty array when DB is empty', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x', project_id: null }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  } finally { d.stop(); }
});

test('POST /recall with invalid input returns 400', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
  } finally { d.stop(); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/daemon/test/recall.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/routes/recall.ts`**

```ts
import type { Services } from '@penumbra/core';
import { RecallRequestSchema } from '@penumbra/core';

export async function recallRoute(req: Request, services: Services): Promise<Response> {
  let raw: unknown;
  try { raw = await req.json(); } catch { return json({ code: 'invalid_json' }, 400); }
  const parsed = RecallRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      code: 'validation_error',
      message: 'body failed schema validation',
      field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    }, 400);
  }
  const results = await services.recallReader.recall(parsed.data);
  services.db.run(
    'INSERT INTO recall_audit(recall_id, ts, project_id, user_id, query_text, result_ids) VALUES(?,?,?,?,?,?)',
    [services.uuid(), services.clock().toISOString(), parsed.data.project_id,
     services.machineId.get(), parsed.data.query,
     JSON.stringify(results.map((r) => r.id))],
  );
  return json({ results });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 4: Modify `src/serve.ts`** — add the recall route

Insert before the `return new Response('not found', ...);` line:

```ts
if (req.method === 'POST' && url.pathname === '/recall') {
  return recallRoute(req, opts.services);
}
```

And add the import at the top:

```ts
import { recallRoute } from './routes/recall.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/daemon/test/recall.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src packages/daemon/test/recall.test.ts && \
  git commit -m "feat(daemon): POST /recall — query+audit+return top-K results"
```

---

### Task 33: GET /metrics route

**Files:**
- Create: `packages/daemon/src/routes/metrics.ts`
- Modify: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/test/metrics.test.ts`

- [ ] **Step 1: Write `test/metrics.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('GET /metrics returns counts, embedder name/dim, and version', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/metrics`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.embedder.name).toBe('test');
    expect(body.embedder.dim).toBe(384);
    expect(body.counts.t0_events).toBe(0);
    expect(body.counts.t1_rollups).toBe(0);
    expect(body.counts.t2_memories).toBe(0);
    expect(body.uptime_sec).toBeGreaterThanOrEqual(0);
  } finally { d.stop(); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/daemon/test/metrics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/routes/metrics.ts`**

```ts
import type { Services } from '@penumbra/core';

const startedAt = Date.now();

export function metricsRoute(services: Services): Response {
  const count = (t: string): number =>
    services.db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${t}`).get()?.c ?? 0;
  return Response.json({
    version: '0.0.0',
    uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
    embedder: { name: services.embedder.name, dim: services.embedder.dim },
    counts: {
      t0_events: count('t0_events'),
      t1_rollups: count('t1_rollups'),
      t2_memories: count('t2_memories'),
      recall_audit: count('recall_audit'),
    },
  });
}
```

- [ ] **Step 4: Modify `src/serve.ts`** — add metrics route

Insert in the bearer-gated section:

```ts
if (req.method === 'GET' && url.pathname === '/metrics') {
  return metricsRoute(opts.services);
}
```

Import at the top:

```ts
import { metricsRoute } from './routes/metrics.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/daemon/test/metrics.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src packages/daemon/test/metrics.test.ts && \
  git commit -m "feat(daemon): GET /metrics — version, uptime, embedder info, row counts"
```

---

## Sprint F — T1 rollup, context file, worker wiring (Tasks 34–37)

### Task 34: T1 rollup aggregator (pure function)

**Files:**
- Create: `packages/core/src/writers/t1.ts`
- Create: `packages/core/test/writers/t1.test.ts`

- [ ] **Step 1: Write `test/writers/t1.test.ts`**

```ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, TestEmbedder } from '../../src/index.js';
import { T1Rollup } from '../../src/writers/t1.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

function seed(sessionId: string, n: number, lane = 'local') {
  for (let i = 0; i < n; i++) {
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES(?, ?, ?, 'mcp', null, 'p1', 'u', 'm', ?, 'agent-tool-use', ?, null, null, null, null, null, null, null, '{}', ?)`,
      [
        `e-${sessionId}-${i}`,
        `2026-04-23T12:0${i}:00Z`,
        `2026-04-23T12:0${i}:00Z`,
        sessionId,
        lane,
        `event ${i}`,
      ],
    );
  }
}

test('rollupSession produces a rollup + vec row with correct counts', async () => {
  seed('s1', 3);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: () => 'rollup-1',
  });
  const written = await roll.rollupSession('s1');
  expect(written).not.toBeNull();
  const row = db
    .query<{ n_events: number; lane_breakdown_json: string }, [string]>(
      'SELECT n_events, lane_breakdown_json FROM t1_rollups WHERE rollup_id=?',
    )
    .get('rollup-1')!;
  expect(row.n_events).toBe(3);
  expect(JSON.parse(row.lane_breakdown_json)).toEqual({ local: 3 });
  expect(
    db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_vec').get()!.c,
  ).toBe(1);
});

test('rollupSession returns null if session has zero events', async () => {
  const roll = new T1Rollup({
    db, embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: () => 'r',
  });
  expect(await roll.rollupSession('nonexistent')).toBeNull();
});

test('rollupSession is idempotent — re-running for same session is a no-op', async () => {
  seed('s1', 2);
  const roll = new T1Rollup({
    db, embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: (() => { let i = 0; return () => `r-${++i}`; })(),
  });
  await roll.rollupSession('s1');
  const second = await roll.rollupSession('s1');
  expect(second).toBeNull();
  expect(
    db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_rollups').get()!.c,
  ).toBe(1);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/writers/t1.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/writers/t1.ts`**

```ts
import { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import type { Clock } from '../utils/clock.js';
import type { Uuid } from '../utils/uuid.js';

export interface T1RollupOpts {
  db: Database;
  embedder: Embedder;
  clock: Clock;
  uuid: Uuid;
}

interface T0Row {
  event_id: string;
  project_id: string | null;
  user_id: string;
  session_id: string;
  ts: string;
  lane: string;
  provider: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  event_type: string;
  payload_summary: string | null;
}

export class T1Rollup {
  constructor(private readonly opts: T1RollupOpts) {}

  async rollupSession(sessionId: string): Promise<string | null> {
    // Skip if already rolled up.
    const existing = this.opts.db
      .query<{ rollup_id: string }, [string]>(
        'SELECT rollup_id FROM t1_rollups WHERE session_id=?',
      )
      .get(sessionId);
    if (existing) return null;

    const rows = this.opts.db
      .query<T0Row, [string]>(
        `SELECT event_id, project_id, user_id, session_id, ts, lane, provider,
                tokens_in, tokens_out, cost_usd, event_type, payload_summary
           FROM t0_events
          WHERE session_id = ?
          ORDER BY ts ASC`,
      )
      .all(sessionId);

    if (rows.length === 0) return null;

    const first = rows[0]!;
    const last = rows[rows.length - 1]!;

    const laneBreakdown: Record<string, number> = {};
    const providerBreakdown: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let firstPrompt: string | null = null;
    let lastResponse: string | null = null;

    for (const row of rows) {
      laneBreakdown[row.lane] = (laneBreakdown[row.lane] ?? 0) + 1;
      if (row.provider) providerBreakdown[row.provider] = (providerBreakdown[row.provider] ?? 0) + 1;
      if (row.event_type === 'agent-tool-use' && row.payload_summary) {
        toolCounts[row.payload_summary.split(' ')[0]!] =
          (toolCounts[row.payload_summary.split(' ')[0]!] ?? 0) + 1;
      }
      if (row.event_type === 'agent-prompt' && firstPrompt === null) {
        firstPrompt = row.payload_summary;
      }
      if (row.event_type === 'agent-response') {
        lastResponse = row.payload_summary;
      }
      tokensIn += row.tokens_in ?? 0;
      tokensOut += row.tokens_out ?? 0;
      cost += row.cost_usd ?? 0;
    }

    const toolCallsSummary = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${n} ${name}`)
      .join(', ');

    const rollupId = this.opts.uuid();
    const embedText = [firstPrompt, lastResponse].filter(Boolean).join('\n\n') || 'empty session';
    const [vec] = await this.opts.embedder.embed([embedText]);

    this.opts.db.exec('BEGIN');
    try {
      this.opts.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                                 n_events, lane_breakdown_json, provider_breakdown_json,
                                 cost_usd_total, tokens_in_total, tokens_out_total,
                                 first_prompt_excerpt, last_response_excerpt, tool_calls_summary,
                                 source_event_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rollupId,
          first.project_id,
          first.user_id,
          sessionId,
          first.ts,
          last.ts,
          rows.length,
          JSON.stringify(laneBreakdown),
          JSON.stringify(providerBreakdown),
          cost || null,
          tokensIn || null,
          tokensOut || null,
          firstPrompt,
          lastResponse,
          toolCallsSummary || null,
          JSON.stringify(rows.map((r) => r.event_id)),
        ],
      );
      const rowid = this.opts.db
        .query<{ rowid: number }, [string]>('SELECT rowid FROM t1_rollups WHERE rollup_id=?')
        .get(rollupId)!.rowid;
      this.opts.db.run('INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)', [rowid, vec!.buffer]);
      this.opts.db.exec('COMMIT');
    } catch (err) {
      this.opts.db.exec('ROLLBACK');
      throw err;
    }
    return rollupId;
  }

  detectIdleSessions(idleMinutes: number, now: Date): string[] {
    type Row = { session_id: string };
    const cutoff = new Date(now.getTime() - idleMinutes * 60_000).toISOString();
    return this.opts.db
      .query<Row, [string]>(
        `SELECT DISTINCT t.session_id
           FROM t0_events t
          WHERE t.session_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM t1_rollups r WHERE r.session_id = t.session_id)
          GROUP BY t.session_id
         HAVING MAX(t.ts) < ?`,
      )
      .all(cutoff)
      .map((r) => r.session_id);
  }
}
```

- [ ] **Step 4: Re-export**

Modify `packages/core/src/index.ts` to add:

```ts
export { T1Rollup } from './writers/t1.js';
export { PidRegistry } from './pid/registry.js';
export { InProcessSupervisor } from './supervisor/in-process.js';
export { resolveProjectId } from './identity/project-id.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/core/test/writers/t1.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/test/writers/t1.test.ts && \
  git commit -m "feat(core): T1Rollup aggregator + idle-session detector"
```

---

### Task 35: Context file writer (atomic rewrite — pain #7)

**Files:**
- Create: `packages/core/src/context-file/writer.ts`
- Create: `packages/core/test/context-file/writer.test.ts`

- [ ] **Step 1: Write `test/context-file/writer.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '../../src/index.js';
import { ContextFileWriter } from '../../src/context-file/writer.js';

let dir = '';
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-ctx-'));
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedT1(rollupId: string, projectId: string, excerpt: string, endedAt: string) {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events,
       first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
     VALUES(?, ?, 'u', ?, ?, ?, 1, ?, ?, '')`,
    [rollupId, projectId, rollupId, endedAt, endedAt, excerpt, excerpt],
  );
}

test('writes atomic latest.md with most-recent T1 rollups', () => {
  seedT1('r1', 'p1', 'first', '2026-04-23T12:00:00Z');
  seedT1('r2', 'p1', 'second', '2026-04-23T13:00:00Z');
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  writer.rewrite('p1');
  const path = join(dir, 'context', 'p1', 'latest.md');
  expect(existsSync(path)).toBe(true);
  const content = readFileSync(path, 'utf8');
  expect(content).toContain('second');
  expect(content.indexOf('second')).toBeLessThan(content.indexOf('first'));
  expect(content).toContain('generated_at');
});

test('empty project produces a file noting "no memories yet"', () => {
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  writer.rewrite('p-empty');
  const path = join(dir, 'context', 'p-empty', 'latest.md');
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('no memories yet');
});

test('rewrite uses a tmp file then renames (never leaves half-written content)', () => {
  seedT1('r1', 'p1', 'hello', '2026-04-23T12:00:00Z');
  const writer = new ContextFileWriter({ db, storageRoot: dir, topK: 5 });
  writer.rewrite('p1');
  // The tmp file must be gone after a successful rewrite.
  const tmps = require('node:fs')
    .readdirSync(join(dir, 'context', 'p1'))
    .filter((f: string) => f.endsWith('.tmp'));
  expect(tmps.length).toBe(0);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/core/test/context-file/writer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/context-file/writer.ts`**

```ts
import { Database } from 'bun:sqlite';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ContextFileWriterOpts {
  db: Database;
  storageRoot: string;
  topK: number;
}

interface RollupRow {
  rollup_id: string;
  started_at: string;
  ended_at: string | null;
  first_prompt_excerpt: string | null;
  last_response_excerpt: string | null;
  tool_calls_summary: string | null;
}

interface MemoryRow {
  memory_id: string;
  title: string;
  body: string;
  created_at: string;
}

export class ContextFileWriter {
  constructor(private readonly opts: ContextFileWriterOpts) {}

  rewrite(projectId: string): void {
    const rollups = this.opts.db
      .query<RollupRow, [string, number]>(
        `SELECT rollup_id, started_at, ended_at, first_prompt_excerpt,
                last_response_excerpt, tool_calls_summary
           FROM t1_rollups
          WHERE project_id = ?
          ORDER BY COALESCE(ended_at, started_at) DESC
          LIMIT ?`,
      )
      .all(projectId, this.opts.topK);

    const memories = this.opts.db
      .query<MemoryRow, [string, number]>(
        `SELECT memory_id, title, body, created_at
           FROM t2_memories
          WHERE project_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(projectId, this.opts.topK);

    const parts: string[] = [];
    parts.push('---');
    parts.push(`generated_at: ${new Date().toISOString()}`);
    parts.push(`project_id: ${projectId}`);
    parts.push(`t1_count: ${rollups.length}`);
    parts.push(`t2_count: ${memories.length}`);
    parts.push('---');
    parts.push('');

    if (rollups.length === 0 && memories.length === 0) {
      parts.push('## no memories yet');
      parts.push('');
      parts.push('Observations have not been rolled up for this project. Use the tool for a few sessions and memories will populate here.');
    } else {
      if (memories.length > 0) {
        parts.push('## Cross-session memories');
        for (const m of memories) parts.push(`### ${m.title}\n\n${m.body}\n`);
      }
      if (rollups.length > 0) {
        parts.push('## Recent sessions');
        for (const r of rollups) {
          parts.push(`### ${r.started_at} → ${r.ended_at ?? 'ongoing'}`);
          if (r.first_prompt_excerpt) parts.push(`- **First prompt:** ${r.first_prompt_excerpt}`);
          if (r.last_response_excerpt) parts.push(`- **Last response:** ${r.last_response_excerpt}`);
          if (r.tool_calls_summary) parts.push(`- **Tools:** ${r.tool_calls_summary}`);
          parts.push('');
        }
      }
    }

    const dir = join(this.opts.storageRoot, 'context', projectId);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `latest.md.${process.pid}.tmp`);
    const final = join(dir, 'latest.md');
    writeFileSync(tmp, parts.join('\n') + '\n', { mode: 0o644 });
    renameSync(tmp, final);
  }
}
```

- [ ] **Step 4: Re-export**

Modify `packages/core/src/index.ts` to add:

```ts
export { ContextFileWriter } from './context-file/writer.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/core/test/context-file/writer.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/test/context-file && \
  git commit -m "feat(core): ContextFileWriter — atomic rewrite, no-memories fallback"
```

---

### Task 36: T1 rollup worker (daemon-side; wraps T1Rollup + ContextFileWriter)

**Files:**
- Create: `packages/daemon/src/workers/t1-rollup.ts`
- Create: `packages/daemon/test/t1-rollup.test.ts`

- [ ] **Step 1: Write `test/t1-rollup.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('rollup worker rolls idle sessions and rewrites the context file', async () => {
  const d = makeTempDaemon();
  try {
    // Seed a T0 event in an old session (past idle threshold).
    const oldTs = '2026-04-22T00:00:00Z';
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES(?, ?, ?, 'mcp', null, 'pA', 'u', 'm', ?, 'agent-prompt', 'local', null, null, null, null, null, null, null, '{}', ?)`,
      ['e1', oldTs, oldTs, 'old-session', 'hello'],
    );

    const { createRollupWorker } = await import('../src/workers/t1-rollup.js');
    const worker = createRollupWorker({
      services: d.services,
      idleMinutes: 5,
    });
    await worker.tick();

    const count = d.services.db
      .query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_rollups')
      .get()!.c;
    expect(count).toBe(1);

    const ctx = Bun.file(`${d.dir}/context/pA/latest.md`);
    expect(await ctx.exists()).toBe(true);
  } finally { d.stop(); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/daemon/test/t1-rollup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/workers/t1-rollup.ts`**

```ts
import type { Services } from '@penumbra/core';
import { T1Rollup, ContextFileWriter } from '@penumbra/core';

export interface RollupWorkerOpts {
  services: Services;
  idleMinutes: number;
  topK?: number;
}

export function createRollupWorker(opts: RollupWorkerOpts) {
  const t1 = new T1Rollup({
    db: opts.services.db,
    embedder: opts.services.embedder,
    clock: opts.services.clock,
    uuid: opts.services.uuid,
  });
  const ctx = new ContextFileWriter({
    db: opts.services.db,
    storageRoot: opts.services.storageRoot,
    topK: opts.topK ?? 10,
  });
  return {
    async tick(): Promise<void> {
      const sessions = t1.detectIdleSessions(opts.idleMinutes, opts.services.clock());
      for (const sessionId of sessions) {
        const id = await t1.rollupSession(sessionId);
        if (id) {
          const projectRow = opts.services.db
            .query<{ project_id: string | null }, [string]>(
              'SELECT project_id FROM t1_rollups WHERE rollup_id=?',
            )
            .get(id);
          if (projectRow?.project_id) ctx.rewrite(projectRow.project_id);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test packages/daemon/test/t1-rollup.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/workers packages/daemon/test/t1-rollup.test.ts && \
  git commit -m "feat(daemon): T1 rollup worker + context-file rewrite on landing"
```

---

### Task 37: Register the rollup worker in the daemon bootstrap

**Files:**
- Modify: `packages/daemon/src/serve.ts`

- [ ] **Step 1: Modify `src/serve.ts`** — wire the worker into the supervisor

Replace the body of `serve` with:

```ts
export function serve(opts: ServeOpts): DaemonHandle {
  const auth = createBearerAuth({ token: opts.token });
  const rollup = createRollupWorker({
    services: opts.services,
    idleMinutes: opts.services.settings.t1SessionIdleMinutes,
  });
  opts.services.supervisor.register({
    name: 't1-rollup',
    intervalMs: opts.services.settings.t1RollupIntervalSec * 1000,
    tick: rollup.tick,
  });
  void opts.services.supervisor.startAll();

  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return healthRoute();
      const denied = auth(req);
      if (denied) return denied;
      if (req.method === 'POST' && url.pathname === '/observations') {
        return observationsRoute(req, opts.services);
      }
      if (req.method === 'POST' && url.pathname === '/recall') {
        return recallRoute(req, opts.services);
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        return metricsRoute(opts.services);
      }
      return new Response('not found', { status: 404 });
    },
  });
  opts.services.log.info({ port: server.port }, 'daemon started');
  return {
    port: server.port,
    stop: () => {
      opts.services.supervisor.stopAll();
      server.stop(true);
    },
  };
}
```

Add the import:

```ts
import { createRollupWorker } from './workers/t1-rollup.js';
```

- [ ] **Step 2: Run the full daemon test suite**

Run: `bun test packages/daemon`
Expected: all prior tests still pass (scheduler now ticks immediately on startup; test fixtures use a clock far in the future, so idle-detection finds no sessions by accident).

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/serve.ts && \
  git commit -m "feat(daemon): register T1 rollup worker + supervisor lifecycle on serve"
```

---

## Sprint G — MCP server (Tasks 38–42)

### Task 38: Scaffold `mcp` package + daemon HTTP client

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/src/daemon-client.ts`
- Create: `packages/mcp/test/daemon-client.test.ts`

- [ ] **Step 1: Write `packages/mcp/package.json`**

```json
{
  "name": "@penumbra/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@penumbra/core": "workspace:*",
    "@nova/mcp-shared": "file:../../../nova/packages/mcp-shared",
    "zod": "^4.3.0"
  }
}
```

- [ ] **Step 2: Write `packages/mcp/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `test/daemon-client.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { DaemonClient } from '../src/daemon-client.js';

test('observe POSTs to /observations with bearer token', async () => {
  let received: { headers: Headers; body: unknown } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { headers: req.headers, body: await req.json() };
      return Response.json({ event_id: 'x' });
    },
  });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    const r = await c.observe({ source: 'mcp', event_type: 'agent-prompt',
      ts: '2026-04-23T12:00:00Z', lane: 'local', payload_json: {} });
    expect(r.event_id).toBe('x');
    expect(received!.headers.get('authorization')).toBe('Bearer tk');
  } finally { server.stop(true); }
});

test('recall POSTs to /recall and returns results', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ results: [{ id: 'a', tier: 't1', score: 0.9, body: 'x',
      title: null, project_id: null, source_session_ids: [], created_at: 'now' }] }),
  });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    const r = await c.recall({ query: 'q', project_id: null });
    expect(r.results[0]!.id).toBe('a');
  } finally { server.stop(true); }
});

test('recall throws on non-2xx', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    await expect(c.recall({ query: 'q', project_id: null })).rejects.toThrow(/HTTP 500/);
  } finally { server.stop(true); }
});
```

- [ ] **Step 4: Run — expect fail**

Run: `bun test packages/mcp/test/daemon-client.test.ts`
Expected: FAIL.

- [ ] **Step 5: Write `src/daemon-client.ts`**

```ts
import type { T0EventInput, RecallRequest, RecallResult } from '@penumbra/core';

export interface DaemonClientOpts {
  baseUrl: string;
  token: string;
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: DaemonClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
  }

  async observe(event: T0EventInput): Promise<{ event_id: string }> {
    return this.post('/observations', event);
  }

  async recall(req: Partial<RecallRequest> & { query: string; project_id: string | null }): Promise<{ results: RecallResult[] }> {
    return this.post('/recall', req);
  }

  async endSession(sessionId: string): Promise<{ ok: true }> {
    return this.post('/sessions/end', { session_id: sessionId });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`daemon ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
```

- [ ] **Step 6: Install and run — expect pass**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install && bun test packages/mcp/test/daemon-client.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp packages/mcp/tsconfig.json bun.lockb && \
  git commit -m "feat(mcp): DaemonClient — HTTP wrapper for observe/recall/endSession"
```

---

### Task 39: Add POST /sessions/end route (daemon side)

**Files:**
- Create: `packages/daemon/src/routes/session-end.ts`
- Modify: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/test/session-end.test.ts`

- [ ] **Step 1: Write `test/session-end.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('POST /sessions/end triggers an immediate rollup for that session', async () => {
  const d = makeTempDaemon();
  try {
    // Seed one event under session 'sX'.
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES('e1', '2026-04-23T12:00:00Z', '2026-04-23T12:00:00Z', 'mcp', null, 'pX', 'u', 'm',
              'sX', 'agent-prompt', 'local', null, null, null, null, null, null, null, '{}', 'hello')`,
    );
    const res = await fetch(`${d.url}/sessions/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sX' }),
    });
    expect(res.status).toBe(200);
    const count = d.services.db
      .query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_rollups WHERE session_id=?')
      .get('sX');
    expect(count?.c).toBe(1);
  } finally { d.stop(); }
});

test('POST /sessions/end with missing session_id returns 400', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/sessions/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  } finally { d.stop(); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/daemon/test/session-end.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/routes/session-end.ts`**

```ts
import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { T1Rollup, ContextFileWriter } from '@penumbra/core';

const BodySchema = z.object({ session_id: z.string().min(1) });

export async function sessionEndRoute(req: Request, services: Services): Promise<Response> {
  let raw: unknown;
  try { raw = await req.json(); } catch { return json({ code: 'invalid_json' }, 400); }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ code: 'validation_error', field_errors: parsed.error.issues }, 400);
  }
  const t1 = new T1Rollup({
    db: services.db, embedder: services.embedder,
    clock: services.clock, uuid: services.uuid,
  });
  const rollupId = await t1.rollupSession(parsed.data.session_id);
  if (rollupId) {
    const row = services.db
      .query<{ project_id: string | null }, [string]>(
        'SELECT project_id FROM t1_rollups WHERE rollup_id=?')
      .get(rollupId);
    if (row?.project_id) {
      new ContextFileWriter({
        db: services.db, storageRoot: services.storageRoot, topK: 10,
      }).rewrite(row.project_id);
    }
  }
  return json({ ok: true, rollup_id: rollupId });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 4: Modify `src/serve.ts`** — add the route

Insert in the bearer-gated block:

```ts
if (req.method === 'POST' && url.pathname === '/sessions/end') {
  return sessionEndRoute(req, opts.services);
}
```

Import:

```ts
import { sessionEndRoute } from './routes/session-end.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/daemon/test/session-end.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src packages/daemon/test/session-end.test.ts && \
  git commit -m "feat(daemon): POST /sessions/end — synchronous rollup + context rewrite"
```

---

### Task 40: MCP tool `memory.observe`

**Files:**
- Create: `packages/mcp/src/tools/observe.ts`
- Create: `packages/mcp/test/helpers.ts`
- Create: `packages/mcp/test/observe.test.ts`

- [ ] **Step 1: Write `test/helpers.ts`**

```ts
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildServer } from '../src/server.js';
import type { DaemonClient } from '../src/daemon-client.js';

export async function connectInMemory(daemon: DaemonClient): Promise<Client> {
  const server = buildServer({ daemon });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}
```

- [ ] **Step 2: Write `test/observe.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('memory.observe forwards to daemon and returns event_id', async () => {
  let received: unknown = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      received = await req.json();
      return Response.json({ event_id: 'e-42' });
    },
  });
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    const client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'memory.observe',
      arguments: {
        ts: '2026-04-23T12:00:00Z',
        source: 'mcp',
        event_type: 'agent-prompt',
        lane: 'local',
        payload_json: { prompt: 'hi' },
      },
    });
    const text = (out.content[0] as { type: 'text'; text: string }).text;
    expect(JSON.parse(text).event_id).toBe('e-42');
    expect(received).toMatchObject({ source: 'mcp', event_type: 'agent-prompt' });
    await client.close();
  } finally { srv.stop(true); }
});
```

- [ ] **Step 3: Run — expect fail**

Run: `bun test packages/mcp/test/observe.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/tools/observe.ts`**

```ts
import { z } from 'zod';
import { T0EventInputSchema } from '@penumbra/core';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const ObserveInputShape = {
  ts: z.string(),
  source: z.enum(['mcp', 'transcript', 'sirius-middleware']),
  source_detail: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  event_type: z.enum(['agent-prompt', 'agent-tool-use', 'agent-response', 'request', 'response']),
  lane: z.enum(['local', 'cloud', 'cli-subscription', 'unknown']),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  tokens_in: z.number().int().nullable().optional(),
  tokens_out: z.number().int().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  latency_ms: z.number().int().nullable().optional(),
  request_id: z.string().nullable().optional(),
  payload_json: z.record(z.string(), z.unknown()),
  payload_summary: z.string().nullable().optional(),
};

export function observeHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = T0EventInputSchema.parse(input);
    const r = await daemon.observe(parsed);
    return toTextContent(r);
  };
}
```

- [ ] **Step 5: Write `src/server.ts` (stub — tools registered incrementally)**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ObserveInputShape, observeHandler } from './tools/observe.js';
import type { DaemonClient } from './daemon-client.js';

export function buildServer(opts: { daemon: DaemonClient }): McpServer {
  const server = new McpServer({ name: 'penumbra', version: '0.0.0' });
  server.registerTool(
    'memory.observe',
    {
      description: 'Record an observation into Penumbra T0.',
      inputSchema: ObserveInputShape,
    },
    observeHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  return server;
}
```

- [ ] **Step 6: Run — expect pass**

Run: `bun test packages/mcp/test/observe.test.ts`
Expected: 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src packages/mcp/test && \
  git commit -m "feat(mcp): memory.observe tool + in-memory transport test harness"
```

---

### Task 41: MCP tool `memory.recall`

**Files:**
- Create: `packages/mcp/src/tools/recall.ts`
- Modify: `packages/mcp/src/server.ts`
- Create: `packages/mcp/test/recall.test.ts`

- [ ] **Step 1: Write `test/recall.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('memory.recall forwards to daemon and returns results', async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      results: [{ id: 'r1', tier: 't1', score: 0.9, body: 'hit', title: null,
        project_id: null, source_session_ids: ['s1'], created_at: '2026-04-23T12:00:00Z' }],
    }),
  });
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    const client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'memory.recall',
      arguments: { query: 'anything', project_id: null, limit: 5 },
    });
    const payload = JSON.parse((out.content[0] as { type: 'text'; text: string }).text);
    expect(payload.results[0].id).toBe('r1');
    await client.close();
  } finally { srv.stop(true); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/mcp/test/recall.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/recall.ts`**

```ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import { RecallRequestSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const RecallInputShape = {
  query: z.string().min(1),
  project_id: z.string().nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
  include_raw: z.boolean().optional(),
  min_score: z.number().min(0).max(1).optional(),
};

export function recallHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = RecallRequestSchema.parse({
      ...(input as object),
      project_id: (input as { project_id?: string | null }).project_id ?? null,
    });
    const r = await daemon.recall(parsed);
    return toTextContent(r);
  };
}
```

- [ ] **Step 4: Modify `src/server.ts`** — register the tool

Replace the function body with:

```ts
export function buildServer(opts: { daemon: DaemonClient }): McpServer {
  const server = new McpServer({ name: 'penumbra', version: '0.0.0' });
  server.registerTool(
    'memory.observe',
    { description: 'Record an observation into Penumbra T0.', inputSchema: ObserveInputShape },
    observeHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'memory.recall',
    { description: 'Retrieve top-K memories (T1+T2) by semantic similarity.', inputSchema: RecallInputShape },
    recallHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  return server;
}
```

Add imports:

```ts
import { RecallInputShape, recallHandler } from './tools/recall.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/mcp/test/recall.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src packages/mcp/test/recall.test.ts && \
  git commit -m "feat(mcp): memory.recall tool"
```

---

### Task 42: MCP tool `session.end` + `penumbra-mcp` bin

**Files:**
- Create: `packages/mcp/src/tools/session-end.ts`
- Modify: `packages/mcp/src/server.ts`
- Create: `packages/mcp/bin/penumbra-mcp.ts`
- Modify: `packages/mcp/package.json` (add `bin` entry)
- Create: `packages/mcp/test/session-end.test.ts`

- [ ] **Step 1: Write `test/session-end.test.ts`**

```ts
import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('session.end forwards to daemon', async () => {
  let body: unknown = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      body = await req.json();
      return Response.json({ ok: true, rollup_id: 'r1' });
    },
  });
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    const client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'session.end',
      arguments: { session_id: 'sX' },
    });
    const payload = JSON.parse((out.content[0] as { type: 'text'; text: string }).text);
    expect(payload.rollup_id).toBe('r1');
    expect(body).toEqual({ session_id: 'sX' });
    await client.close();
  } finally { srv.stop(true); }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/mcp/test/session-end.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/tools/session-end.ts`**

```ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const SessionEndInputShape = {
  session_id: z.string().min(1),
};

export function sessionEndHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = z.object(SessionEndInputShape).parse(input);
    const r = await daemon.endSession(parsed.session_id);
    return toTextContent(r);
  };
}
```

- [ ] **Step 4: Modify `src/server.ts`** — register the third tool

Add at the bottom of `buildServer`:

```ts
server.registerTool(
  'session.end',
  { description: 'Signal that a session ended; triggers a synchronous T1 rollup.', inputSchema: SessionEndInputShape },
  sessionEndHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
```

Import:

```ts
import { SessionEndInputShape, sessionEndHandler } from './tools/session-end.js';
```

- [ ] **Step 5: Write `bin/penumbra-mcp.ts`**

```ts
#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildServer } from '../src/server.js';
import { DaemonClient } from '../src/daemon-client.js';

const root = process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra');
const tokenPath = join(root, 'token');
const portPath = join(root, 'port');

if (!existsSync(tokenPath) || !existsSync(portPath)) {
  console.error(`penumbra-mcp: missing ${tokenPath} or ${portPath}. Run 'penumbra init' + 'penumbra start' first.`);
  process.exit(1);
}

const token = readFileSync(tokenPath, 'utf8').trim();
const port = readFileSync(portPath, 'utf8').trim();
const daemon = new DaemonClient({ baseUrl: `http://127.0.0.1:${port}`, token });

const server = buildServer({ daemon });
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 6: Add `bin` to `packages/mcp/package.json`**

Add under the top-level object:

```json
"bin": {
  "penumbra-mcp": "./bin/penumbra-mcp.ts"
}
```

- [ ] **Step 7: Run — expect pass**

Run: `bun test packages/mcp`
Expected: all MCP tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp && \
  git commit -m "feat(mcp): session.end tool + penumbra-mcp stdio bin"
```

---

## Sprint H — CLI (Tasks 43–47)

### Task 43: Scaffold `cli` package + `penumbra init`

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/bin/penumbra.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/test/init.test.ts`

- [ ] **Step 1: Write `packages/cli/package.json`**

```json
{
  "name": "@penumbra/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "penumbra": "./bin/penumbra.ts" },
  "dependencies": {
    "@penumbra/core": "workspace:*"
  }
}
```

- [ ] **Step 2: Write `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "references": [{ "path": "../core" }],
  "include": ["bin/**/*.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `test/init.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-init-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('init creates storage root, token, port placeholder, and DB file', async () => {
  const exit = await runInit({ storageRoot: dir, uuid: () => 'tok-123' });
  expect(exit).toBe(0);
  expect(existsSync(join(dir, 'token'))).toBe(true);
  expect(readFileSync(join(dir, 'token'), 'utf8').trim()).toBe('tok-123');
  expect(existsSync(join(dir, 'db.sqlite'))).toBe(true);
});

test('init is idempotent — running twice keeps the same token', async () => {
  await runInit({ storageRoot: dir, uuid: () => 'tok-1' });
  const first = readFileSync(join(dir, 'token'), 'utf8').trim();
  await runInit({ storageRoot: dir, uuid: () => 'tok-2' });
  const second = readFileSync(join(dir, 'token'), 'utf8').trim();
  expect(second).toBe(first);
});
```

- [ ] **Step 4: Run — expect fail**

Run: `bun test packages/cli/test/init.test.ts`
Expected: FAIL.

- [ ] **Step 5: Write `src/commands/init.ts`**

```ts
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSqliteVec, migrate, systemUuid, type Uuid } from '@penumbra/core';

export interface RunInitOpts {
  storageRoot: string;
  uuid?: Uuid;
  embeddingDim?: number;
}

export async function runInit(opts: RunInitOpts): Promise<number> {
  const uuid = opts.uuid ?? systemUuid;
  mkdirSync(opts.storageRoot, { recursive: true });

  const tokenPath = join(opts.storageRoot, 'token');
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, `${uuid()}\n`, { mode: 0o600 });
  }

  const dbPath = join(opts.storageRoot, 'db.sqlite');
  const db = new Database(dbPath, { create: true });
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: opts.embeddingDim ?? 384 });
  } finally {
    db.close();
  }

  console.log(`penumbra: initialized at ${opts.storageRoot}`);
  return 0;
}
```

- [ ] **Step 6: Write `bin/penumbra.ts`** (stub dispatcher that we will grow)

```ts
#!/usr/bin/env bun
import { Branding } from '@penumbra/core';
import { runInit } from '../src/commands/init.js';
import { homedir } from 'node:os';

const cmd = process.argv[2];
const root = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;

switch (cmd) {
  case 'init':
    process.exit(await runInit({ storageRoot: root }));
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`usage: penumbra <init|start|stop|status|export|import|repair>`);
    process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
```

- [ ] **Step 7: Install + run — expect pass**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install && bun test packages/cli/test/init.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli bun.lockb tsconfig.json && \
  git commit -m "feat(cli): scaffold @penumbra/cli + 'penumbra init' command"
```

---

### Task 44: `penumbra start` + `penumbra stop`

**Files:**
- Create: `packages/cli/src/commands/start.ts`
- Create: `packages/cli/src/commands/stop.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Create: `packages/cli/test/start-stop.test.ts`

- [ ] **Step 1: Write `test/start-stop.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runStart } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';

let dir = '';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-ss-'));
  await runInit({ storageRoot: dir, uuid: () => 'tok' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('start writes port + pid files; stop removes them', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    expect(existsSync(join(dir, 'port'))).toBe(true);
    expect(existsSync(join(dir, 'pid'))).toBe(true);
    const port = Number(readFileSync(join(dir, 'port'), 'utf8'));
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
  expect(existsSync(join(dir, 'port'))).toBe(false);
  expect(existsSync(join(dir, 'pid'))).toBe(false);
});

test('start refuses if a live daemon is already running', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    await expect(runStart({ storageRoot: dir })).rejects.toThrow(/already running/);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/cli/test/start-stop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/start.ts`**

```ts
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, resolveEmbedder, BundledEmbedder } from '@penumbra/core';
import { serve, type DaemonHandle } from '@penumbra/daemon';

export interface RunStartOpts {
  storageRoot: string;
}

export async function runStart(opts: RunStartOpts): Promise<DaemonHandle> {
  const pidPath = join(opts.storageRoot, 'pid');
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, 'utf8'));
    if (pid && isAlive(pid)) {
      throw new Error(`penumbra already running (pid=${pid})`);
    }
    unlinkSync(pidPath);
  }

  const token = readFileSync(join(opts.storageRoot, 'token'), 'utf8').trim();
  const dbPath = join(opts.storageRoot, 'db.sqlite');
  const db = new Database(dbPath);
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const embedder = await resolveEmbedder({
    preferSirius: process.env.PENUMBRA_EMBEDDER_PREFER_SIRIUS === 'true',
    fallback: new BundledEmbedder(),
  });

  const services = buildServices({
    env: process.env,
    input: {},
    storageRoot: opts.storageRoot,
    db,
    embedder,
  });

  const handle = serve({ services, token, port: 0 });
  writeFileSync(join(opts.storageRoot, 'port'), `${handle.port}\n`, { mode: 0o644 });
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o644 });
  services.log.info({ pid: process.pid, port: handle.port }, 'penumbra running');
  return handle;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

- [ ] **Step 4: Write `src/commands/stop.ts`**

```ts
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonHandle } from '@penumbra/daemon';

export interface RunStopOpts {
  storageRoot: string;
  handle?: DaemonHandle;
}

export async function runStop(opts: RunStopOpts): Promise<number> {
  opts.handle?.stop();
  for (const f of ['port', 'pid']) {
    const p = join(opts.storageRoot, f);
    if (existsSync(p)) unlinkSync(p);
  }
  // If the process is remote (no in-proc handle), signal by pid.
  if (!opts.handle) {
    const pidPath = join(opts.storageRoot, 'pid');
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
    }
  }
  return 0;
}
```

- [ ] **Step 5: Add `@penumbra/daemon` as a dep of `@penumbra/cli`**

Modify `packages/cli/package.json`, `dependencies`:

```json
"@penumbra/daemon": "workspace:*"
```

Then `bun install` at the repo root.

- [ ] **Step 6: Modify `bin/penumbra.ts`** — wire `start` and `stop`

Replace the switch with:

```ts
switch (cmd) {
  case 'init':
    process.exit(await runInit({ storageRoot: root }));
  case 'start': {
    const handle = await runStart({ storageRoot: root });
    process.on('SIGINT', async () => { await runStop({ storageRoot: root, handle }); process.exit(0); });
    process.on('SIGTERM', async () => { await runStop({ storageRoot: root, handle }); process.exit(0); });
    console.log(`penumbra: running on http://127.0.0.1:${handle.port} (pid=${process.pid}). Ctrl-C to stop.`);
    await new Promise<never>(() => {}); // block forever; signals drive exit
    process.exit(0);
  }
  case 'stop':
    process.exit(await runStop({ storageRoot: root }));
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log('usage: penumbra <init|start|stop|status|export|import|repair>');
    process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
```

Add imports at the top:

```ts
import { runStart } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';
```

- [ ] **Step 7: Run — expect pass**

```bash
bun install && bun test packages/cli/test/start-stop.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli bun.lockb && \
  git commit -m "feat(cli): penumbra start/stop with pid+port files and stale-pid handling"
```

---

### Task 45: `penumbra status`

**Files:**
- Create: `packages/cli/src/commands/status.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Create: `packages/cli/test/status.test.ts`

- [ ] **Step 1: Write `test/status.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runStart } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';
import { runStatus } from '../src/commands/status.js';

let dir = '';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-status-'));
  await runInit({ storageRoot: dir, uuid: () => 'tok' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('status returns "running" when daemon is up', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    const r = await runStatus({ storageRoot: dir });
    expect(r.status).toBe('running');
    expect(r.port).toBe(handle.port);
    expect(r.embedder).toBeDefined();
  } finally { await runStop({ storageRoot: dir, handle }); }
});

test('status returns "stopped" when pid/port files are absent', async () => {
  const r = await runStatus({ storageRoot: dir });
  expect(r.status).toBe('stopped');
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/cli/test/status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/status.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StatusResult {
  status: 'running' | 'stopped' | 'stale';
  port?: number;
  pid?: number;
  embedder?: { name: string; dim: number };
}

export async function runStatus(opts: { storageRoot: string }): Promise<StatusResult> {
  const pidPath = join(opts.storageRoot, 'pid');
  const portPath = join(opts.storageRoot, 'port');
  const tokenPath = join(opts.storageRoot, 'token');
  if (!existsSync(pidPath) || !existsSync(portPath)) return { status: 'stopped' };
  const pid = Number(readFileSync(pidPath, 'utf8'));
  const port = Number(readFileSync(portPath, 'utf8'));
  try { process.kill(pid, 0); } catch { return { status: 'stale', pid, port }; }
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: 'stale', pid, port };
    const body = (await res.json()) as { embedder: { name: string; dim: number } };
    return { status: 'running', pid, port, embedder: body.embedder };
  } catch {
    return { status: 'stale', pid, port };
  }
}
```

- [ ] **Step 4: Modify `bin/penumbra.ts`** — wire `status`

Add under the switch:

```ts
case 'status': {
  const s = await runStatus({ storageRoot: root });
  console.log(JSON.stringify(s, null, 2));
  process.exit(s.status === 'running' ? 0 : 2);
}
```

Import:

```ts
import { runStatus } from '../src/commands/status.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/cli/test/status.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli && \
  git commit -m "feat(cli): penumbra status — liveness check + /metrics probe"
```

---

### Task 46: `penumbra export` and `penumbra import`

**Files:**
- Create: `packages/cli/src/commands/export.ts`
- Create: `packages/cli/src/commands/import.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Create: `packages/cli/test/export-import.test.ts`

- [ ] **Step 1: Write `test/export-import.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { runExport } from '../src/commands/export.js';
import { runImport } from '../src/commands/import.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-ei-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function freshDb() {
  const path = join(dir, 'db.sqlite');
  const db = new Database(path, { create: true });
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return { db, path };
}

test('export dumps JSONL, import restores it idempotently', async () => {
  const { db, path } = freshDb();
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
      session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary)
     VALUES('e1','2026-04-23T00:00:00Z','2026-04-23T00:00:00Z','mcp',null,'p','u','m','s','agent-prompt','local',
            null,null,null,null,null,null,null,'{}',null)`,
  );
  db.close();

  const outPath = join(dir, 'dump.jsonl');
  await runExport({ dbPath: path, project: null, outPath });
  const dumpText = readFileSync(outPath, 'utf8');
  expect(dumpText).toContain('"event_id":"e1"');

  // Wipe and re-import.
  rmSync(path);
  const { db: db2, path: path2 } = freshDb();
  db2.close();
  await runImport({ dbPath: path2, inPath: outPath });
  const db3 = new Database(path2);
  const count = db3.query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get()!.c;
  db3.close();
  expect(count).toBe(1);

  // Re-importing is a no-op.
  await runImport({ dbPath: path2, inPath: outPath });
  const db4 = new Database(path2);
  const count2 = db4.query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get()!.c;
  db4.close();
  expect(count2).toBe(1);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/cli/test/export-import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/export.ts`**

```ts
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';

export interface RunExportOpts {
  dbPath: string;
  project: string | null;
  outPath: string;
}

export async function runExport(opts: RunExportOpts): Promise<number> {
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    const lines: string[] = [];
    const tables = ['projects', 't0_events', 't1_rollups', 't2_memories'] as const;
    for (const table of tables) {
      const where = opts.project ? 'WHERE project_id=?' : '';
      const params = opts.project ? [opts.project] : [];
      const rows = db
        .query<Record<string, unknown>, typeof params>(
          `SELECT * FROM ${table} ${where}`,
        )
        .all(...(params as []));
      for (const row of rows) {
        lines.push(JSON.stringify({ table, row }));
      }
    }
    writeFileSync(opts.outPath, lines.join('\n') + '\n');
  } finally { db.close(); }
  return 0;
}
```

- [ ] **Step 4: Write `src/commands/import.ts`**

```ts
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

export interface RunImportOpts {
  dbPath: string;
  inPath: string;
}

const PK: Record<string, string> = {
  projects: 'project_id',
  t0_events: 'event_id',
  t1_rollups: 'rollup_id',
  t2_memories: 'memory_id',
};

export async function runImport(opts: RunImportOpts): Promise<number> {
  const db = new Database(opts.dbPath);
  try {
    db.exec('BEGIN');
    const content = readFileSync(opts.inPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const { table, row } = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      const pk = PK[table];
      if (!pk) continue;
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(',');
      db.run(
        `INSERT INTO ${table}(${cols.join(',')}) VALUES(${placeholders}) ON CONFLICT(${pk}) DO NOTHING`,
        cols.map((c) => row[c] as string | number | null) as (string | number | null)[],
      );
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  return 0;
}
```

- [ ] **Step 5: Modify `bin/penumbra.ts`** — wire `export` and `import`

Add cases:

```ts
case 'export': {
  const outPath = process.argv[3] ?? join(root, 'export.jsonl');
  const projectFlagIdx = process.argv.indexOf('--project');
  const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
  const dbPath = join(root, 'db.sqlite');
  process.exit(await runExport({ dbPath, project, outPath }));
}
case 'import': {
  const inPath = process.argv[3];
  if (!inPath) { console.error('usage: penumbra import <file.jsonl>'); process.exit(1); }
  const dbPath = join(root, 'db.sqlite');
  process.exit(await runImport({ dbPath, inPath }));
}
```

Imports:

```ts
import { join } from 'node:path';
import { runExport } from '../src/commands/export.js';
import { runImport } from '../src/commands/import.js';
```

- [ ] **Step 6: Run — expect pass**

Run: `bun test packages/cli/test/export-import.test.ts`
Expected: 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/cli && \
  git commit -m "feat(cli): penumbra export/import — UUID-idempotent JSONL round-trip"
```

---

### Task 47: `penumbra repair` (sqlite3 CLI fallback)

**Files:**
- Create: `packages/cli/src/commands/repair.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Create: `packages/cli/test/repair.test.ts`

- [ ] **Step 1: Write `test/repair.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { runRepair } from '../src/commands/repair.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-repair-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('on a healthy DB, repair reports ok without touching the file', async () => {
  const dbPath = join(dir, 'db.sqlite');
  const db = new Database(dbPath, { create: true });
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.close();

  const result = await runRepair({ storageRoot: dir });
  expect(result.outcome).toBe('ok');
});

test('on a corrupt DB, repair falls back to the most recent backup', async () => {
  const dbPath = join(dir, 'db.sqlite');
  const db = new Database(dbPath, { create: true });
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.close();

  // Stage a backup copy.
  const backupDir = join(dir, 'backups');
  const backupPath = join(backupDir, '2026-04-22.db');
  require('node:fs').mkdirSync(backupDir, { recursive: true });
  copyFileSync(dbPath, backupPath);

  // Corrupt the primary DB.
  writeFileSync(dbPath, 'not a sqlite file');

  const result = await runRepair({ storageRoot: dir });
  expect(result.outcome).toBe('restored-from-backup');
  expect(existsSync(dbPath)).toBe(true);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun test packages/cli/test/repair.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/repair.ts`**

```ts
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type RepairOutcome = 'ok' | 'recovered' | 'restored-from-backup' | 'failed';
export interface RepairResult { outcome: RepairOutcome; notes: string[] }

export async function runRepair(opts: { storageRoot: string }): Promise<RepairResult> {
  const notes: string[] = [];
  const dbPath = join(opts.storageRoot, 'db.sqlite');

  const integrity = spawnSync('sqlite3', [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' });
  if (integrity.status === 0 && integrity.stdout.trim() === 'ok') {
    notes.push('integrity_check: ok');
    return { outcome: 'ok', notes };
  }
  notes.push(`integrity_check failed: ${(integrity.stdout || integrity.stderr || '').trim()}`);

  const recoverPath = `${dbPath}.recovered`;
  const recoverSql = spawnSync('sqlite3', [dbPath, '.recover'], { encoding: 'utf8' });
  if (recoverSql.status === 0 && recoverSql.stdout.length > 0) {
    const load = spawnSync('sqlite3', [recoverPath], { input: recoverSql.stdout, encoding: 'utf8' });
    if (load.status === 0 && existsSync(recoverPath)) {
      rmSync(dbPath, { force: true });
      copyFileSync(recoverPath, dbPath);
      rmSync(recoverPath, { force: true });
      notes.push('recovered via sqlite3 .recover');
      return { outcome: 'recovered', notes };
    }
  }
  notes.push('.recover pipeline failed');

  const backupDir = join(opts.storageRoot, 'backups');
  if (existsSync(backupDir)) {
    const picks = readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse();
    const mostRecent = picks[0];
    if (mostRecent) {
      rmSync(dbPath, { force: true });
      copyFileSync(join(backupDir, mostRecent), dbPath);
      notes.push(`restored from backup ${mostRecent}`);
      return { outcome: 'restored-from-backup', notes };
    }
  }

  notes.push('no backups available');
  return { outcome: 'failed', notes };
}
```

- [ ] **Step 4: Modify `bin/penumbra.ts`** — wire `repair`

Add a case:

```ts
case 'repair': {
  const r = await runRepair({ storageRoot: root });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.outcome === 'failed' ? 2 : 0);
}
```

Import:

```ts
import { runRepair } from '../src/commands/repair.js';
```

- [ ] **Step 5: Run — expect pass**

Run: `bun test packages/cli/test/repair.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli && \
  git commit -m "feat(cli): penumbra repair — sqlite3 integrity/.recover + backup fallback"
```

---

## Sprint I — End-to-end integration (Tasks 48–49)

### Task 48: MCP → daemon → DB → recall round-trip

**Files:**
- Create: `packages/mcp/test/e2e.test.ts`

- [ ] **Step 1: Write `test/e2e.test.ts`**

```ts
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../cli/src/commands/init.js';
import { runStart } from '../../cli/src/commands/start.js';
import { runStop } from '../../cli/src/commands/stop.js';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

let dir = '';
let handle: Awaited<ReturnType<typeof runStart>> | null = null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-e2e-'));
  await runInit({ storageRoot: dir, uuid: () => 't' });
  process.env.PENUMBRA_STORAGE_ROOT = dir;
  handle = await runStart({ storageRoot: dir });
});

afterEach(async () => {
  if (handle) await runStop({ storageRoot: dir, handle });
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PENUMBRA_STORAGE_ROOT;
});

test('observe → session.end → recall returns the session content', async () => {
  const daemon = new DaemonClient({ baseUrl: `http://127.0.0.1:${handle!.port}`, token: 't' });
  const client = await connectInMemory(daemon);

  await client.callTool({
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-test',
      session_id: 's-e2e',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: 'proj-e2e',
      payload_json: { prompt: 'refactor the authentication middleware' },
      payload_summary: 'refactor the authentication middleware',
    },
  });

  await client.callTool({
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-test',
      session_id: 's-e2e',
      event_type: 'agent-response',
      lane: 'local',
      project_id: 'proj-e2e',
      payload_json: { response: 'Updated src/auth.ts and tests' },
      payload_summary: 'Updated src/auth.ts and tests',
    },
  });

  await client.callTool({
    name: 'session.end',
    arguments: { session_id: 's-e2e' },
  });

  const recall = await client.callTool({
    name: 'memory.recall',
    arguments: { query: 'refactor the authentication middleware', project_id: 'proj-e2e', limit: 5 },
  });
  const payload = JSON.parse((recall.content[0] as { type: 'text'; text: string }).text);
  expect(payload.results.length).toBe(1);
  expect(payload.results[0].tier).toBe('t1');
  expect(payload.results[0].body).toContain('refactor');

  await client.close();
});

test('context file is written for the project after session.end', async () => {
  const daemon = new DaemonClient({ baseUrl: `http://127.0.0.1:${handle!.port}`, token: 't' });
  const client = await connectInMemory(daemon);
  await client.callTool({
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-test',
      session_id: 's-ctx',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: 'proj-ctx',
      payload_json: { prompt: 'x' },
      payload_summary: 'x',
    },
  });
  await client.callTool({ name: 'session.end', arguments: { session_id: 's-ctx' } });
  const ctxFile = Bun.file(join(dir, 'context', 'proj-ctx', 'latest.md'));
  expect(await ctxFile.exists()).toBe(true);
  const content = await ctxFile.text();
  expect(content).toContain('generated_at');
  expect(content).toContain('Recent sessions');
  await client.close();
});
```

- [ ] **Step 2: Run the E2E test — expect pass**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/mcp/test/e2e.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/test/e2e.test.ts && \
  git commit -m "test(e2e): observe → session.end → recall round-trip + context file"
```

---

### Task 49: Final verification and repo-wide typecheck

**Files:** (no new files; verification only)

- [ ] **Step 1: Run the entire test suite**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test
```

Expected: all tests pass (baseline ≥ 90 tests across core/daemon/mcp/cli).

- [ ] **Step 2: Run repo-wide typecheck**

```bash
bun run typecheck
```

Expected: zero errors across all four packages.

- [ ] **Step 3: Run cross-repo nova test sweep (spec-required discipline)**

Because this plan depends on `@nova/contracts` and `@nova/mcp-shared` via `file:` deps, verify nova stays green before calling V1 done:

```bash
(cd ../nova && bun test)
```

Expected: nova test suite still passes at its documented baseline (≥ 157 tests).

- [ ] **Step 4: Tag V1 release candidate**

```bash
git tag v0.1.0-rc1 -m "V1 foundation + Tool 1 (memory via MCP) — release candidate"
```

- [ ] **Step 5: Final commit (docs-only — no code change)**

Nothing to commit. The tag is the boundary marker.

---

## Self-review

**Spec coverage:**
- Foundation: Bun workspace, branding, settings, clock/uuid, logger, machine-id, redaction — Tasks 1–8. ✓
- DB: sqlite-vec, schema, meta, migrations — Tasks 9–12. ✓
- Schemas: T0 event, T1 rollup, project, recall — Tasks 13–14. ✓
- Project identity: git/marker/declared/quarantine chain + DB cache — Tasks 15–17. ✓
- Normalizer + T0 writer — Tasks 18–19. ✓
- Embedder: interface, TestEmbedder, bundled ONNX, sirius adapter, layered resolver — Tasks 20–23. ✓
- Recall reader — Task 24. ✓
- PID registry + supervisor + services — Tasks 25–27. ✓
- Daemon: package, auth, /health, /observations, /recall, /metrics — Tasks 28–33. ✓
- T1 rollup + context file + worker registration — Tasks 34–37. ✓
- MCP: daemon client, /sessions/end route, memory.observe, memory.recall, session.end, stdio bin — Tasks 38–42. ✓
- CLI: init, start, stop, status, export, import, repair — Tasks 43–47. ✓
- E2E integration — Task 48. ✓
- Final verification — Task 49. ✓

**Deferred (spec explicit) — NOT in this plan:**
- Tool 2 (dream mode, embersynth integration) — own plan.
- Tool 3 (routing advisories, DuckDB) — own plan.
- Transcript-watcher integration — own plan.
- Sirius-middleware integration — own plan (lives in sirius repo too).
- Viewer UI — own plan.
- Advisor agent — own plan.
- Prometheus metrics format — not V1.
- Unix-socket transport (Candidate C migration) — not V1.

**Placeholder scan:** No TBDs, TODOs, "implement later," or "similar to Task N" in the task bodies. Every code step contains the full code the engineer writes.

**Type consistency check:**
- `Clock` (Task 4) and `Uuid` (Task 4) are imported consistently in Tasks 6, 17, 18, 20, 27, 34 — same module path, same type shape.
- `Embedder` interface (Task 20) implemented by `TestEmbedder` (Task 20), `BundledEmbedder` (Task 21), `SiriusEmbedder` (Task 22); `resolveEmbedder` (Task 23) returns the same type; `RecallReader` (Task 24) consumes it; `Services.embedder` (Task 27) carries it; `runStart` (Task 44) builds it.
- `Services` (Task 27) shape consumed verbatim by `observationsRoute` (Task 31), `recallRoute` (Task 32), `metricsRoute` (Task 33), `sessionEndRoute` (Task 39), `createRollupWorker` (Task 36).
- `T0Event` / `T0EventInput` (Task 13) are the only event types referenced; `normalize` (Task 18) accepts input, returns strict; `T0Writer.write` (Task 19) consumes strict. No drift.
- `RecallRequest` / `RecallResult` (Task 14) flow: schema → HTTP route (Task 32) → DaemonClient (Task 38) → MCP tool (Task 41).
- `DaemonHandle` (Task 30) surface stable: `runStart` returns it (Task 44), `runStop` accepts it (Task 44).
- All `bun:sqlite` `Database` uses are compatible across tasks; `prepare` / `query` / `run` / `exec` used with consistent arity.

**Scope check:** This plan produces working software on its own: after Task 49 you have a Penumbra daemon you can point Claude Code (or any MCP client) at via `penumbra-mcp`, observe session events, end a session, recall memories, and read a context file. Subsequent plans (dream mode, advisories, sirius-middleware, transcript-watcher, viewer, advisor agent) are additive on this foundation.

**Ambiguity check:**
- All code uses exact file paths, no "similar to" references.
- Settings knob names are precisely spelled (`PENUMBRA_T0_RETENTION_DAYS` etc.).
- Test seeds use explicit rows, not implicit side-effects.
- Commit messages name the layer (`feat(core):`, `feat(daemon):`, `feat(mcp):`, `feat(cli):`, `test(e2e):`, `chore(…):`).

All self-review checks pass.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-23-penumbra-v1-memory-core.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.

2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?








