import { afterEach, expect, spyOn, test, vi } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { buildRegistry as buildWorkflowRegistry } from '@penumbra/workflows';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import { reloadConfigRoute } from '../../src/routes/reload-config.js';
import { formatAgentChatConfigError } from '../../src/agentchat-config.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

afterEach(() => {
  delete process.env.PENUMBRA_CONFIG_DIR;
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempServices(opts?: { agentRegistry?: string[] | null; workflowDirs?: { playbooksDir: string; workflowsDir: string } }): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const worktreeRootDir = mkdtempSync(join(tmpdir(), 'reload-config-worktrees-'));
  tempDirs.push(worktreeRootDir);
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/reload-config-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: Object.assign(() => new Date('2026-04-26T00:00:00Z'), {
      toISOString: () => '2026-04-26T00:00:00.000Z',
      now: () => 1714089600000,
    }),
    uuid: () => `id-${++n}`,
    agentRegistry: opts?.agentRegistry ?? ['planner', 'executor'],
    worktreeRootDir,
  });
  // Default to an empty tmp dir so workflow_count is deterministic and the
  // route doesn't pick up the live repo's playbooks during tests.
  const dirs = opts?.workflowDirs ?? (() => {
    const root = mkdtempSync(join(tmpdir(), 'reload-cfg-empty-'));
    tempDirs.push(root);
    return { playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') };
  })();
  (services as Services & { workflowDirs?: typeof dirs }).workflowDirs = dirs;
  return services;
}

async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'reload-config-home-'));
  tempDirs.push(home);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = previousHome;
  }
}

function writeWorkersYaml(home: string, content: string): string {
  const workersPath = join(home, '.config', 'penumbra', 'workers.yaml');
  mkdirSync(join(home, '.config', 'penumbra'), { recursive: true });
  writeFileSync(workersPath, content);
  return workersPath;
}

function writeSplitAgentchatConfig(configDir: string, content: string): void {
  const parsed = (parseYaml(content) ?? {}) as Record<string, unknown>;
  const agentsDoc: Record<string, unknown> = { ...parsed };
  delete agentsDoc.default_roles;
  delete agentsDoc.role_routing;
  delete agentsDoc.providers;

  const routingDoc: Record<string, unknown> = {
    default_roles: parsed.default_roles ?? {},
  };
  if (parsed.role_routing !== undefined) {
    routingDoc.role_routing = parsed.role_routing;
  }

  const quotasDoc: Record<string, unknown> = {
    providers: Array.isArray(parsed.providers) ? parsed.providers : [],
  };

  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'agents.yaml'), stringifyYaml(agentsDoc));
  writeFileSync(join(configDir, 'routing.yaml'), stringifyYaml(routingDoc));
  writeFileSync(join(configDir, 'quotas.yaml'), stringifyYaml(quotasDoc));
}

test('POST /agentchat/reload replaces agentRegistry and returns info', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');

  writeAgentchat(yamlPath, `
  agents:
  - name: test-agent-1
    adapter: mock
  - name: test-agent-2
    adapter: mock
  `);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  const infoSpy = spyOn(services.log, 'info').mockImplementation(() => undefined as any);
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agent_count).toBe(2);
    expect(body.reloaded_at).toBe('2026-04-26T00:00:00.000Z');
    expect(services.agentRegistry).toEqual(['test-agent-1', 'test-agent-2']);
    expect(services.agentRouting?.role_exploration_policy).toBe('unsampled-first');
    expect(body.project_registry_count).toBe(services.projectRegistry?.list().length ?? 0);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        agent_count: 2,
        prev_count: 2,
        workflow_count: 0,
        project_registry_count: services.projectRegistry?.list().length ?? 0,
        reactor_status: 'absent',
      },
      'agentchat-config-reloaded',
    );
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload swaps role exploration policy from agentchat config', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-routing.yaml');

  writeAgentchat(yamlPath, `
agents:
  - name: test-agent-1
    adapter: mock
    roles: [executor]
default_roles:
  executor: test-agent-1
role_routing:
  exploration_policy: ranked-first
`);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.agentRouting?.role_exploration_policy).toBe('ranked-first');
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload reloads the long-lived reactor when present', async () => {
  const services = tempServices();
  let reloadCalls = 0;
  (services as Services & { longLivedReactor?: { reload: () => Promise<void> } }).longLivedReactor = {
    reload: async () => {
      reloadCalls += 1;
    },
  };
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-reactor.yaml');

  writeAgentchat(yamlPath, `
agents:
  - name: test-agent-1
    adapter: mock
`);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reactor_status).toBe('reloaded');
    expect(body.reactor_error).toBeUndefined();
    expect(reloadCalls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload soft-fails long-lived reactor reload errors', async () => {
  const services = tempServices();
  (services as Services & { longLivedReactor?: { reload: () => Promise<void> } }).longLivedReactor = {
    reload: async () => {
      throw new Error('reactor exploded');
    },
  };
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-reactor-fail.yaml');

  writeAgentchat(yamlPath);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agent_count).toBe(1);
    expect(body.reactor_status).toBe('failed');
    expect(body.reactor_error).toBe('reactor exploded');
    expect(warnSpy).toHaveBeenCalledWith(
      { error: 'reactor exploded' },
      'long-lived-reactor-reload-failed',
    );
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload refreshes providerQuotas from agentchat config', async () => {
  const services = tempServices();
  services.providerQuotas = [{ provider: 'placeholder', quota_usd_per_24h: 1 } as any];
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-providers.yaml');

  writeAgentchat(yamlPath, `
agents:
  - name: test-agent-1
    adapter: mock
providers:
  - name: anthropic
    model: claude-sonnet-4
    pressure_caps:
      five_hour:
        warn: 80
        refuse: 95
  - name: gemini
    model: gemini-2.5-pro
    pressure_caps:
      five_hour: 90
`);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.providerQuotas).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        quota_usd_per_24h: undefined,
        quota_tokens_per_24h: undefined,
        quota_tokens_per_5h: undefined,
        pressure_caps: {
          five_hour: {
            warn: 80,
            refuse: 95,
          },
        },
      },
      {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        quota_usd_per_24h: undefined,
        quota_tokens_per_24h: undefined,
        quota_tokens_per_5h: undefined,
        pressure_caps: {
          five_hour: {
            warn: null,
            refuse: 90,
          },
        },
      },
    ]);
    expect(services.providerQuotas.some((entry) => entry.provider === 'placeholder')).toBe(false);
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload returns 422 if file missing', async () => {
  const services = tempServices();
  process.env.PENUMBRA_CONFIG_DIR = '/tmp/does-not-exist.yaml';
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('not found');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {}
});

test('POST /agentchat/reload returns 422 and does not swap if yaml invalid', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-invalid.yaml');
  
  writeAgentchat(yamlPath, `
agents:
  - no_name: true
`);

  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('agents.0.name');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload honors PENUMBRA_CONFIG_DIR', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-alt.yaml');

  writeAgentchat(yamlPath, `
agents:
  - name: override-agent
    adapter: mock
`);

  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.agentRegistry).toEqual(['override-agent']);
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload refreshes agentchatConfig and shellConfig', async () => {
  const services = tempServices();
  const runtime = services as Services & { agentchatConfig?: any; shellConfig?: any };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-shell.yaml');

  writeAgentchat(yamlPath, `
agents:
  - name: shell-agent
    adapter: mock
shell:
  enabled: true
  dangerous_commands:
    - '^danger\\b'
`);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    let res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(runtime.agentchatConfig?.agents?.[0]?.name).toBe('shell-agent');
    expect(runtime.agentchatConfig?.agents?.[0]?.auto_approve_to ?? []).toEqual([]);
    expect(runtime.shellConfig?.enabled).toBe(true);
    expect(runtime.shellConfig?.dangerousCommandsForAgent?.('shell-agent')).toEqual(['^danger\\b']);

    writeAgentchat(yamlPath, `
agents:
  - name: shell-agent
    adapter: mock
    auto_approve_to: [shell_run]
shell:
  enabled: true
  dangerous_commands:
    - '^rm\\b'
`);
    res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(runtime.agentchatConfig?.agents?.[0]?.auto_approve_to).toEqual(['shell_run']);
    expect(runtime.shellConfig?.dangerousCommandsForAgent?.('shell-agent')).toEqual(['^rm\\b']);
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

const PLAYBOOK_V1 = `---
name: alpha
description: v1
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
template v1
`;

const PLAYBOOK_V2 = `---
name: alpha
description: v2
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
template v2
`;

const PLAYBOOK_BETA = `---
name: beta
description: b
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
template b
`;

function writeAgentchat(path: string, content?: string): void {
  writeSplitAgentchatConfig(
    path,
    content ?? `
agents:
  - name: test-agent
    adapter: mock
`,
  );
}

test('POST /agentchat/reload rebuilds workflow registry from disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reload-cfg-wf-'));
  const playbooksDir = join(root, 'playbooks');
  const workflowsDir = join(root, 'workflows');
  mkdirSync(join(playbooksDir, 'alpha'), { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(playbooksDir, 'alpha', 'playbook.md'), PLAYBOOK_V1);

  const services = tempServices({ workflowDirs: { playbooksDir, workflowsDir } });
  // Pre-populate registry as the daemon would at boot, then mutate disk.
  services.workflowRegistry = await buildWorkflowRegistry({ playbooksDir, workflowsDir });
  expect(services.workflowRegistry.get('alpha')?.description).toBe('v1');

  // Add a second playbook + edit the first.
  mkdirSync(join(playbooksDir, 'beta'), { recursive: true });
  writeFileSync(join(playbooksDir, 'beta', 'playbook.md'), PLAYBOOK_BETA);
  writeFileSync(join(playbooksDir, 'alpha', 'playbook.md'), PLAYBOOK_V2);

  const yamlPath = join(root, 'agentchat.yaml');
  writeAgentchat(yamlPath);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;

  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.workflow_count).toBe(2);
    expect(services.workflowRegistry?.list().map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    expect(services.workflowRegistry?.get('alpha')?.description).toBe('v2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /agentchat/reload returns 500 and keeps old workflow registry on rebuild failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reload-cfg-wf-bad-'));
  const goodPlaybooks = join(root, 'playbooks');
  const workflowsDir = join(root, 'workflows');
  mkdirSync(join(goodPlaybooks, 'alpha'), { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(goodPlaybooks, 'alpha', 'playbook.md'), PLAYBOOK_V1);

  // Build the initial (good) registry.
  const services = tempServices({ workflowDirs: { playbooksDir: goodPlaybooks, workflowsDir } });
  services.workflowRegistry = await buildWorkflowRegistry({ playbooksDir: goodPlaybooks, workflowsDir });
  const originalRegistry = services.workflowRegistry;
  expect(originalRegistry?.get('alpha')?.description).toBe('v1');

  // Now point the route at a path that's a regular file, not a directory —
  // existsSync passes but readdirSync throws ENOTDIR, which buildRegistry
  // surfaces as a thrown error rather than collecting in errors[].
  const badPath = join(root, 'not-a-dir');
  writeFileSync(badPath, 'definitely not a directory');
  (services as Services & { workflowDirs?: { playbooksDir: string; workflowsDir: string } }).workflowDirs = {
    playbooksDir: badPath,
    workflowsDir,
  };

  const yamlPath = join(root, 'agentchat.yaml');
  writeAgentchat(yamlPath);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  const errSpy = spyOn(services.log, 'error').mockImplementation(() => undefined as any);
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('workflow registry rebuild failed');
    expect(services.workflowRegistry).toBe(originalRegistry);
    expect(services.workflowRegistry?.get('alpha')?.description).toBe('v1');
    expect(errSpy).toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('formatAgentChatConfigError redacts apiKey/token/secret fields', () => {
  const formatted = formatAgentChatConfigError(new Error(
    'agentchat config invalid: agents.0.options.apiKey: got "sk-live-123"; agents.1.options.token: received abc123; agents.2.options.secret: bad value',
  ));
  expect(formatted).toContain('agents.0.options.apiKey: <redacted>');
  expect(formatted).toContain('agents.1.options.token: <redacted>');
  expect(formatted).toContain('agents.2.options.secret: <redacted>');
  expect(formatted).not.toContain('sk-live-123');
  expect(formatted).not.toContain('abc123');
});

test('POST /agentchat/reload returns empty worker_extras when workers.yaml is absent', async () => {
  const services = tempServices();
  const reconcile = vi.fn().mockResolvedValue({
    started: [],
    restarted: [],
    stopped: [],
    skipped: [],
    errors: [],
  });
  (services as Services & { extraWorkerSupervisor?: { reconcile: (extras: unknown[]) => Promise<unknown> } }).extraWorkerSupervisor = { reconcile };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  writeAgentchat(yamlPath);

  await withTempHome(async () => {
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker_extras).toEqual({
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    });
    expect(reconcile).toHaveBeenCalledWith([]);
  });
});

test('POST /agentchat/reload surfaces invalid workers.yaml errors without extra worker supervisor', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    const workersPath = writeWorkersYaml(home, 'extras: [');
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker_extras.error).toContain('workers.yaml');
    expect(body.worker_extras.error).toContain(workersPath);
  });
});

test('POST /agentchat/reload restarts and tracks added workers from workers.yaml', async () => {
  const services = tempServices();
  const state: string[] = ['worker-a'];
  const reconcile = vi.fn(async (extras: { id: string }[]) => {
    const next = extras.map((item) => item.id);
    const nextSet = new Set(next);
    const started = next.filter((id) => !state.includes(id));
    const stopped = state.filter((id) => !nextSet.has(id));
    for (const id of stopped) {
      state.splice(state.indexOf(id), 1);
    }
    for (const id of started) state.push(id);
    return {
      started,
      restarted: [],
      stopped,
      skipped: [],
      errors: [],
    };
  });
  (services as Services & { extraWorkerSupervisor?: { reconcile: (extras: unknown[]) => Promise<unknown> } }).extraWorkerSupervisor = { reconcile };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    writeWorkersYaml(home, `
extras:
  - id: worker-a
    isolation: shared
`);
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    let res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);

    writeWorkersYaml(home, `
extras:
  - id: worker-a
    isolation: shared
  - id: worker-b
    project_id: penumbra
    isolation: hard
`);
    res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    const body = await res.json();
    expect(body.worker_extras).toEqual({
      started: ['worker-b'],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    });
  });
});

test('POST /agentchat/reload restarts and tracks removed workers from workers.yaml', async () => {
  const services = tempServices();
  const state: string[] = ['worker-a', 'worker-b'];
  const reconcile = vi.fn(async (extras: { id: string }[]) => {
    const next = extras.map((item) => item.id);
    const nextSet = new Set(next);
    const stopped = state.filter((id) => !nextSet.has(id));
    const started = next.filter((id) => !state.includes(id));
    state.splice(0);
    state.push(...next);
    return {
      started,
      restarted: [],
      stopped,
      skipped: [],
      errors: [],
    };
  });
  (services as Services & { extraWorkerSupervisor?: { reconcile: (extras: unknown[]) => Promise<unknown> } }).extraWorkerSupervisor = { reconcile };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    writeWorkersYaml(home, `
extras:
  - id: worker-a
    isolation: shared
  - id: worker-b
    project_id: penumbra
    isolation: hard
`);
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);

    writeWorkersYaml(home, `
extras:
  - id: worker-a
    isolation: shared
`);
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    const body = await res.json();
    expect(body.worker_extras).toEqual({
      started: [],
      restarted: [],
      stopped: ['worker-b'],
      skipped: [],
      errors: [],
    });
  });
});

test('POST /agentchat/reload reports worker_reconcile_errors for invalid workers.yaml', async () => {
  const services = tempServices();
  const reconcile = vi.fn().mockResolvedValue({
    started: [],
    restarted: [],
    stopped: [],
    skipped: [],
    errors: [],
  });
  (services as Services & { extraWorkerSupervisor?: { reconcile: (extras: unknown[]) => Promise<unknown> } }).extraWorkerSupervisor = { reconcile };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    const workersPath = writeWorkersYaml(home, 'extras: [');
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker_extras.error).toEqual(expect.stringContaining(workersPath));
    expect(reconcile).not.toHaveBeenCalled();
  });
});

test('POST /agentchat/reload surfaces worker reconcile spawn errors', async () => {
  const services = tempServices();
  const reconcile = vi.fn().mockResolvedValue({
    started: [],
    restarted: [],
    stopped: [],
    skipped: ['worker-a'],
    errors: [{ worker_id: 'worker-a', message: 'spawn failed' }],
  });
  (services as Services & { extraWorkerSupervisor?: { reconcile: (extras: unknown[]) => Promise<unknown> } }).extraWorkerSupervisor = { reconcile };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    writeWorkersYaml(home, `
extras:
  - id: worker-a
    isolation: shared
`);
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker_extras).toEqual({
      started: [],
      restarted: [],
      stopped: [],
      skipped: ['worker-a'],
      errors: [{ worker_id: 'worker-a', message: 'spawn failed' }],
    });
  });
});
