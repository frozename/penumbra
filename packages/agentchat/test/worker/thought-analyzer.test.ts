import { describe, expect, it, mock } from 'bun:test';
import { runThoughtAnalyzer } from '../../src/worker/thought-analyzer.js';
import type { RuntimeThoughtsConfig } from '../../src/worker/thought-config.js';

const baseConfig: RuntimeThoughtsConfig = {
  enabled: true,
  capture: { maxTextBytes: 16384, maxStreamBytes: 1048576, adapters: {}, perAgentOverrides: {} },
  analyze: {
    enabled: true,
    onlyWhen: ['pr_opened'],
    digest: { enabled: true, agent: 'local-gemma26', maxInputChars: 1000, timeoutMs: 5000 },
    signals: {
      enabled: true,
      agent: 'local-gemma26',
      timeoutMs: 5000,
      maxInputChars: null,
      definitions: [
        { name: 'uncertainty', prompt: 'list doubts' },
        { name: 'security', prompt: 'list security concerns' },
      ],
    },
  },
};

const sampleThoughts = [
  { sequence_n: 0, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'thinking about A' },
  { sequence_n: 1, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'thinking about B' },
];

describe('runThoughtAnalyzer', () => {
  it('dispatches digest and one signal per definition in parallel', async () => {
    const calls: any[] = [];
    const recorded: any[] = [];
    const chainStart = mock(async (input: { initial_agent: string; message: string; parent_handoff_id?: string }) => {
      calls.push(input);
      return { conversation_id: `conv-${calls.length}`, handoff_id: `h-sub-${calls.length}` };
    });
    const chainWait = mock(async () => ({ status: 'completed' as const }));
    const chainResponse = mock(async () => ({ responses: [{ text: `response for call ${calls.length}` }] }));
    const recordEvent = mock(async (e: any) => { recorded.push(e); });

    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'pr_opened',
      config: baseConfig,
      deps: { chainStart, chainWait, chainResponse, recordEvent, log: console },
    });

    expect(chainStart).toHaveBeenCalledTimes(3);
    const recordedKinds = recorded.map((r) => r.kind);
    expect(recordedKinds.filter((k) => k === 'agent.thought.digest')).toHaveLength(1);
    expect(recordedKinds.filter((k) => k === 'agent.thought.signal')).toHaveLength(2);
    const signalNames = recorded.filter((r) => r.kind === 'agent.thought.signal').map((r) => r.meta.signal_name);
    expect(signalNames.sort()).toEqual(['security', 'uncertainty']);
  });

  it('passes parent handoff project_id into sub-dispatches', async () => {
    const calls: any[] = [];
    const chainStart = mock(async (input: {
      initial_agent: string;
      message: string;
      parent_handoff_id: string;
      project_id: string | null;
      task_type: string;
    }) => {
      calls.push(input);
      return { conversation_id: `conv-${calls.length}`, handoff_id: `h-sub-${calls.length}` };
    });

    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'pr_opened',
      config: baseConfig,
      deps: {
        chainStart,
        chainWait: mock(async () => ({ status: 'completed' as const })),
        chainResponse: mock(async () => ({ responses: [{ text: 'ok' }] })),
        recordEvent: mock(async () => {}),
        log: console,
        getHandoff: async () => ({ project_id: 'parent-proj' }),
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.project_id === 'parent-proj')).toBe(true);
  });

  it('skips analyze when mergeStatus is not in onlyWhen', async () => {
    const chainStart = mock(async () => ({ conversation_id: 'x', handoff_id: 'y' }));
    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'cancelled',
      config: baseConfig,
      deps: {
        chainStart,
        chainWait: mock(async () => ({ status: 'completed' as const })),
        chainResponse: mock(async () => ({ responses: [] })),
        recordEvent: mock(async () => {}),
        log: console,
      },
    });
    expect(chainStart).not.toHaveBeenCalled();
  });

  it('records a digest event with failure text when the digest sub-handoff fails', async () => {
    const recorded: any[] = [];
    const chainStart = mock(async (input: { message: string }) => {
      if (input.message.includes('list doubts') || input.message.includes('list security')) {
        return { conversation_id: 'sig', handoff_id: 'h-sig' };
      }
      throw new Error('digest dispatch failed');
    });
    const chainWait = mock(async () => ({ status: 'completed' as const }));
    const chainResponse = mock(async () => ({ responses: [{ text: 'signal text' }] }));
    const recordEvent = mock(async (e: any) => { recorded.push(e); });

    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'pr_opened',
      config: baseConfig,
      deps: { chainStart, chainWait, chainResponse, recordEvent, log: console },
    });

    const digestRow = recorded.find((r) => r.kind === 'agent.thought.digest');
    expect(digestRow).toBeDefined();
    expect((digestRow!.meta.digest_text as string)).toContain('analyzer failed');
    expect(recorded.filter((r) => r.kind === 'agent.thought.signal')).toHaveLength(2);
  });

  it('truncates the analyzer prompt to maxInputChars and notes the truncation', async () => {
    const captured: string[] = [];
    const chainStart = mock(async (input: { message: string }) => {
      captured.push(input.message);
      return { conversation_id: 'c', handoff_id: 'h' };
    });
    const big = Array.from({ length: 200 }, (_, i) => ({ sequence_n: i, adapter: 'x', agent_name: 'y', text: 'x'.repeat(50) }));
    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: big,
      mergeStatus: 'pr_opened',
      config: { ...baseConfig, analyze: { ...baseConfig.analyze, digest: { ...baseConfig.analyze.digest, maxInputChars: 200 } } },
      deps: {
        chainStart,
        chainWait: mock(async () => ({ status: 'completed' as const })),
        chainResponse: mock(async () => ({ responses: [{ text: 'ok' }] })),
        recordEvent: mock(async () => {}),
        log: console,
      },
    });
    const digestPrompt = captured.find((m) => m.includes('list')) ?? captured[0]!;
    expect(digestPrompt.length).toBeLessThan(2000);
    expect(digestPrompt).toContain('truncated');
  });
});
