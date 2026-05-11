import { beforeAll, describe, expect, it } from 'bun:test';

let TOOL_REGISTRY: Record<string, any> | null = null;
let importError: unknown = null;

beforeAll(async () => {
  try {
    const mod = await import('../../src/tools/registry');
    TOOL_REGISTRY = mod.TOOL_REGISTRY;
  } catch (err) {
    importError = err;
  }
});

const TOOL_NAMES = [
  'agent.rank',
  'agent.recommend',
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
  'long_lived_reject_action',
  'long_lived_resume',
  'long_lived_retire',
  'long_lived_state_get',
  'long_lived_state_set',
  'long_lived_ticks',
  'maestro.session_get',
  'memory.corpus_build',
  'memory.corpus_list',
  'memory.corpus_query',
  'memory.get_observations',
  'memory.observe',
  'memory.recall',
  'memory.search',
  'memory.status',
  'memory.timeline',
  'permission.approve',
  'permission.get',
  'permission.list_pending',
  'plan.cancel',
  'plan.list',
  'plan.start',
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
  'memory.corpus_list',
  'memory.corpus_query',
  'memory.get_observations',
  'memory.recall',
  'memory.search',
  'memory.status',
  'memory.timeline',
  'permission.get',
  'permission.list_pending',
  'plan.list',
  'plan.status',
  'long_lived_get',
  'long_lived_list',
  'long_lived_pending_actions',
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
  'daemon.reload_config',
  'dispatch.land',
  'handoff.approve',
  'long_lived_pause',
  'long_lived_resume',
  'long_lived_retire',
  'long_lived_state_set',
  'long_lived_approve_action',
  'long_lived_reject_action',
  'long_lived_inject_goal',
  'memory.corpus_build',
  'memory.observe',
  'permission.approve',
  'plan.cancel',
  'plan.start',
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
});
