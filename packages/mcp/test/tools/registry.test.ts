import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TOOL_REGISTRY: Record<string, any> | null = null;
let createProjectIdResolverFromCwd: ((opts?: {
  cwd?: string;
  registryPath?: string;
  loadRegistry?: (path: string) => any;
  findProjectId?: (registry: any, cwd: string) => string | undefined;
  statPath?: (path: string) => { mtimeMs: number };
}) => () => string | undefined) | null = null;
let resetProjectRegistryCache: (() => void) | null = null;
let importError: unknown = null;

beforeAll(async () => {
  try {
    const mod = await import('../../src/tools/registry');
    TOOL_REGISTRY = mod.TOOL_REGISTRY;
    createProjectIdResolverFromCwd = mod.createProjectIdResolverFromCwd;
    resetProjectRegistryCache = mod.__resetProjectRegistryCacheForTest;
  } catch (err) {
    importError = err;
  }
});

const TOOL_NAMES = [
  'agent.rank',
  'agent.recommend',
  'agent.route_for',
  'brainstorm',
  'chain.cancel',
  'chain.get_messages',
  'chain.get_response',
  'chain.history',
  'chain.list_agents',
  'chain.start',
  'chain.status',
  'chain.wait',
  'chain_send_message',
  'cost.quota_status',
  'subscription_pressure_status',
  'cost.recent',
  'daemon.reload_config',
  'dispatch.audit',
  'dispatch.land',
  'dispatch.timeline',
  'fs.glob',
  'fs.grep',
  'handoff.approve',
  'handoff.get',
  'handoff.list_pending',
  'long_lived_approve_action',
  'long_lived_audit',
  'long_lived_get',
  'long_lived_inject_goal',
  'long_lived_list',
  'long_lived_pause',
  'long_lived_pending_actions',
  'long_lived_self_pending_actions',
  'long_lived_self_state_get',
  'long_lived_self_state_set',
  'long_lived_reject_action',
  'long_lived_resume',
  'long_lived_retire',
  'long_lived_state_get',
  'long_lived_state_set',
  'long_lived_tick',
  'long_lived_ticks',
  'lane_close',
  'lane_ledger_recent',
  'lane_open',
  'maestro.session_get',
  'maestro_session_start',
  'maestro_session_start_adhoc',
  'maestro_capabilities',
  'memory.corpus_build',
  'memory.corpus_list',
  'memory.corpus_query',
  'memory.efficacy_rebuild',
  'memory.efficacy_recent',
  'memory.get_observations',
  'memory.observe',
  'memory.recall',
  'memory.search',
  'memory.status',
  'memory.verify',
  'memory.timeline',
  'permission.approve',
  'permission.get',
  'permission.list_pending',
  'plan.cancel',
  'plan.list',
  'plan.start',
  'plan_open',
  'plan.status',
  'reconciler.sweep_orphan_prs',
  'reconciler.verdicts',
  'session.end',
  'shell_close',
  'shell_list',
  'shell_run',
  'task.cancel',
  'task.comment_gh',
  'task.complete',
  'task.fail',
  'task.file',
  'task.get',
  'task.heartbeat',
  'task.link_gh',
  'task.list',
  'task.next',
  'task.sync_gh_now',
  'task.unlink_gh',
  'worktree.cleanup',
  'worktree.inspect',
  'worktree.list',
  'workflow.history',
  'workflow.list',
  'workflow.run',
  'workflow.suggest',
] as const;

const READ_ONLY_TOOL_NAMES = [
  'agent.rank',
  'agent.recommend',
  'agent.route_for',
  'chain.get_messages',
  'chain.get_response',
  'chain.history',
  'chain.list_agents',
  'chain.status',
  'chain.wait',
  'cost.quota_status',
  'subscription_pressure_status',
  'cost.recent',
  'dispatch.audit',
  'dispatch.timeline',
  'fs.glob',
  'fs.grep',
  'handoff.get',
  'handoff.list_pending',
  'maestro.session_get',
  'maestro_capabilities',
  'memory.corpus_list',
  'memory.corpus_query',
  'memory.efficacy_recent',
  'memory.get_observations',
  'memory.recall',
  'memory.search',
  'memory.status',
  'lane_ledger_recent',
  'memory.timeline',
  'permission.get',
  'permission.list_pending',
  'plan.list',
  'plan.status',
  'long_lived_get',
  'long_lived_list',
  'long_lived_pending_actions',
  'long_lived_self_pending_actions',
  'long_lived_self_state_get',
  'long_lived_audit',
  'long_lived_state_get',
  'long_lived_ticks',
  'shell_list',
  'task.get',
  'task.list',
  'task.next',
  'reconciler.verdicts',
  'workflow.history',
  'workflow.list',
  'workflow.suggest',
  'worktree.inspect',
  'worktree.list',
] as const;

const MUTATING_TOOL_NAMES = [
  'chain.cancel',
  'chain.start',
  'chain_send_message',
  'brainstorm',
  'daemon.reload_config',
  'dispatch.land',
  'handoff.approve',
  'long_lived_pause',
  'long_lived_resume',
  'long_lived_retire',
  'long_lived_state_set',
  'long_lived_self_state_set',
  'lane_close',
  'lane_open',
  'long_lived_approve_action',
  'long_lived_reject_action',
  'long_lived_inject_goal',
  'long_lived_tick',
  'memory.corpus_build',
  'memory.efficacy_rebuild',
  'memory.observe',
  'memory.verify',
  'maestro_session_start',
  'maestro_session_start_adhoc',
  'permission.approve',
  'plan.cancel',
  'plan.start',
  'plan_open',
  'reconciler.sweep_orphan_prs',
  'session.end',
  'shell_close',
  'shell_run',
  'task.cancel',
  'task.comment_gh',
  'task.complete',
  'task.fail',
  'task.file',
  'task.heartbeat',
  'task.link_gh',
  'task.sync_gh_now',
  'task.unlink_gh',
  'workflow.run',
  'worktree.cleanup',
] as const;

describe('TOOL_REGISTRY', () => {
  it('module loads', () => {
    expect(importError).toBeNull();
    expect(TOOL_REGISTRY).not.toBeNull();
  });

  it('has the expected tool names', () => {
    if (importError || !TOOL_REGISTRY) return;

    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('matches the registry shape and readOnly snapshot', () => {
    if (importError || !TOOL_REGISTRY) return;

    const allNames = [...READ_ONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES];
    expect(new Set(READ_ONLY_TOOL_NAMES).size).toBe(READ_ONLY_TOOL_NAMES.length);
    expect(new Set(MUTATING_TOOL_NAMES).size).toBe(MUTATING_TOOL_NAMES.length);
    expect(new Set(allNames).size).toBe(TOOL_NAMES.length);
    expect([...allNames].sort()).toEqual([...TOOL_NAMES].sort());

    for (const name of TOOL_NAMES) {
      const entry = TOOL_REGISTRY[name];
      expect(entry).toBeDefined();
      expect(typeof entry.descriptor?.description).toBe('string');
      expect(entry.descriptor.description.length).toBeGreaterThan(0);
      expect(typeof entry.makeHandler).toBe('function');
      expect(typeof entry.readOnly).toBe('boolean');
      expect(entry.readOnly).toBe(READ_ONLY_TOOL_NAMES.includes(name));
    }

    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(TOOL_REGISTRY[name].readOnly).toBe(true);
    }

    for (const name of MUTATING_TOOL_NAMES) {
      expect(TOOL_REGISTRY[name].readOnly).toBe(false);
    }
  });

  it('wraps handoff.get results with acting_on for handoff_id inputs', async () => {
    if (importError || !TOOL_REGISTRY) return;

    const daemon = {
      getHandoff: async (handoffId: string) => ({
        handoff: { handoff_id: handoffId, status: 'pending', from_agent: 'user', to_agent: 'codex' },
      }),
    } as any;
    const handler = TOOL_REGISTRY['handoff.get'].makeHandler(daemon);
    const result = await handler({ handoff_id: 'abc' });

    expect((result as any).acting_on).toEqual({ kind: 'handoff', id: 'abc' });
    expect(Object.keys(result as Record<string, unknown>)[0]).toBe('acting_on');
    expect((result as any).content?.[0]?.text).toContain('"handoff_id": "abc"');
  });

  it('wraps task.get results with acting_on for task_id inputs', async () => {
    if (importError || !TOOL_REGISTRY) return;

    const daemon = {
      taskGet: async (taskId: string) => ({
        task_id: taskId,
        status: 'open',
      }),
    } as any;
    const handler = TOOL_REGISTRY['task.get'].makeHandler(daemon);
    const result = await handler({ task_id: 'xyz' });

    expect((result as any).acting_on).toEqual({ kind: 'task', id: 'xyz' });
    expect(Object.keys(result as Record<string, unknown>)[0]).toBe('acting_on');
    expect((result as any).content?.[0]?.text).toMatch(/"task_id"\s*:\s*"xyz"/);
  });

  it('chain.start makeHandler injects cwd-resolved project_id when omitted', async () => {
    if (importError || !TOOL_REGISTRY || !resetProjectRegistryCache) return;

    const root = mkdtempSync(join(tmpdir(), 'penumbra-mcp-chain-start-'));
    const registryPath = join(root, 'projects.yaml');
    writeFileSync(
      registryPath,
      `projects:\n  - project_id: penumbra\n    root_path: "${process.cwd()}"\n`,
      'utf8',
    );

    const daemon = {
      startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
    } as any;
    const previous = process.env.PENUMBRA_PROJECTS_YAML;

    try {
      process.env.PENUMBRA_PROJECTS_YAML = registryPath;
      resetProjectRegistryCache();
      const handler = TOOL_REGISTRY['chain.start'].makeHandler(daemon);

      await handler({ initial_agent: 'planner', message: 'hi' });

      expect(daemon.startChain).toHaveBeenCalledWith(expect.objectContaining({
        initial_agent: 'planner',
        message: 'hi',
        project_id: 'penumbra',
      }));
    } finally {
      if (previous === undefined) delete process.env.PENUMBRA_PROJECTS_YAML;
      else process.env.PENUMBRA_PROJECTS_YAML = previous;
      rmSync(root, { recursive: true, force: true });
      resetProjectRegistryCache();
    }
  });

  it('caches project registry by mtime and reloads when mtime changes', () => {
    if (importError || !createProjectIdResolverFromCwd || !resetProjectRegistryCache) return;

    const root = mkdtempSync(join(tmpdir(), 'penumbra-mcp-registry-'));
    const registryPath = join(root, 'projects.yaml');
    writeFileSync(
      registryPath,
      'projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n',
      'utf8',
    );

    const loadRegistry = mock((path: string) => ({ path }));
    const findProjectId = mock((_registry: any, _cwd: string) => 'penumbra');

    try {
      resetProjectRegistryCache();
      const resolver = createProjectIdResolverFromCwd({
        cwd: '/tmp/penumbra',
        registryPath,
        loadRegistry,
        findProjectId,
      });

      expect(resolver()).toBe('penumbra');
      expect(resolver()).toBe('penumbra');
      expect(loadRegistry).toHaveBeenCalledTimes(1);

      const now = Date.now() / 1000;
      utimesSync(registryPath, now, now + 1);

      expect(resolver()).toBe('penumbra');
      expect(loadRegistry).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
