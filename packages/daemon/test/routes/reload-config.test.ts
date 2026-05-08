import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { buildRegistry as buildWorkflowRegistry } from '@penumbra/workflows';
import { reloadConfigRoute } from '../../src/routes/reload-config.js';
import { formatAgentChatConfigError } from '../../src/agentchat-config.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

afterEach(() => {
  delete process.env.PENUMBRA_AGENTCHAT_CONFIG;
});

function tempServices(opts?: { agentRegistry?: string[] | null; workflowDirs?: { playbooksDir: string; workflowsDir: string } }): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
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
  });
  // Default to an empty tmp dir so workflow_count is deterministic and the
  // route doesn't pick up the live repo's playbooks during tests.
  const dirs = opts?.workflowDirs ?? (() => {
    const root = mkdtempSync(join(tmpdir(), 'reload-cfg-empty-'));
    return { playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') };
  })();
  (services as Services & { workflowDirs?: typeof dirs }).workflowDirs = dirs;
  return services;
}

test('POST /agentchat/reload replaces agentRegistry and returns info', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat.yaml');
  
  writeFileSync(yamlPath, `
  agents:
  - name: test-agent-1
    adapter: mock
  - name: test-agent-2
    adapter: mock
  `);
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
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
    expect(infoSpy).toHaveBeenCalledWith({ agent_count: 2, prev_count: 2, workflow_count: 0 }, 'agentchat-config-reloaded');
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload swaps role exploration policy from agentchat config', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-routing.yaml');

  writeFileSync(yamlPath, `
agents:
  - name: test-agent-1
    adapter: mock
    roles: [executor]
default_roles:
  executor: test-agent-1
role_routing:
  exploration_policy: ranked-first
`);
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.agentRouting?.role_exploration_policy).toBe('ranked-first');
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload refreshes providerQuotas from agentchat config', async () => {
  const services = tempServices();
  services.providerQuotas = [{ provider: 'placeholder', quota_usd_per_24h: 1 } as any];
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-providers.yaml');

  writeFileSync(yamlPath, `
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
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
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
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload returns 422 if file missing', async () => {
  const services = tempServices();
  process.env.PENUMBRA_AGENTCHAT_CONFIG = '/tmp/does-not-exist.yaml';
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
  
  writeFileSync(yamlPath, `
agents:
  - no_name: true
`);

  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('agentchat config invalid');
    expect(services.agentRegistry).toEqual(['planner', 'executor']); // untouched
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload honors PENUMBRA_AGENTCHAT_CONFIG', async () => {
  const services = tempServices();
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-alt.yaml');

  writeFileSync(yamlPath, `
agents:
  - name: override-agent
    adapter: mock
`);

  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    const res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(services.agentRegistry).toEqual(['override-agent']);
  } finally {
    unlinkSync(yamlPath);
  }
});

test('POST /agentchat/reload refreshes agentchatConfig and shellConfig', async () => {
  const services = tempServices();
  const runtime = services as Services & { agentchatConfig?: any; shellConfig?: any };
  const testDir = join('/tmp', 'penumbra-reload-test');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, 'agentchat-shell.yaml');

  writeFileSync(yamlPath, `
agents:
  - name: shell-agent
    adapter: mock
shell:
  enabled: true
  dangerous_commands:
    - '^danger\\b'
`);
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
  try {
    let res = await reloadConfigRoute(new Request('http://x/agentchat/reload', { method: 'POST' }), services);
    expect(res.status).toBe(200);
    expect(runtime.agentchatConfig?.agents?.[0]?.name).toBe('shell-agent');
    expect(runtime.agentchatConfig?.agents?.[0]?.auto_approve_to ?? []).toEqual([]);
    expect(runtime.shellConfig?.enabled).toBe(true);
    expect(runtime.shellConfig?.dangerousCommandsForAgent?.('shell-agent')).toEqual(['^danger\\b']);

    writeFileSync(yamlPath, `
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
    unlinkSync(yamlPath);
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

function writeAgentchat(path: string): void {
  writeFileSync(path, `
agents:
  - name: test-agent
    adapter: mock
`);
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
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;

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
  process.env.PENUMBRA_AGENTCHAT_CONFIG = yamlPath;
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
