import { expect, test, mock } from 'bun:test';

// Mock dependencies before importing the module under test
mock.module('../src/config/load.js', () => ({
  loadConfig: () => ({
    agents: [
      { name: 'cloud-1', adapter: 'openai-compat-http', options: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' } },
      { name: 'cloud-2', adapter: 'openai-compat-http', options: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama3-70b' } },
      { name: 'local-cli', adapter: 'claude-cli', options: {} },
    ],
    default_roles: {}
  })
}));

mock.module('../src/adapters/secret.js', () => ({
  resolveAdapterApiKey: () => 'mock-api-key'
}));

// We'll mock the internal bench/grade calls to avoid real network but still test the flow
let runBenchCalls = 0;
mock.module('./bench.js', () => ({
  runBench: async (opts: any) => {
    runBenchCalls++;
    return [
      { task: 'T4', latencyMs: 100, label: opts.label, model: opts.model },
      { task: 'T5', latencyMs: 200, label: opts.label, model: opts.model },
      { task: 'T6', latencyMs: 300, label: opts.label, model: opts.model },
      { task: 'T7', latencyMs: 400, label: opts.label, model: opts.model },
      { task: 'T8', latencyMs: 500, label: opts.label, model: opts.model },
    ];
  }
}));

let gradeResultsCalls = 0;
mock.module('./bench-grade.js', () => ({
  gradeResults: async (opts: any) => {
    gradeResultsCalls++;
    return opts.results.map((r: any) => ({
      task: r.task,
      verdict: r.task === 'T4' ? 'PASS' : 'FAIL',
      model: r.model,
      label: r.label
    }));
  }
}));

// Now import the function to test
import { runFleetBench } from './bench-fleet.js';

test('runFleetBench: enumerates only HTTP agents and aggregates results', async () => {
  runBenchCalls = 0;
  gradeResultsCalls = 0;

  // Capture console.log to verify the table
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    await runFleetBench({ skipGrade: false });

    // Should have called bench/grade for the 2 HTTP agents, skipped the CLI one
    expect(runBenchCalls).toBe(2);
    expect(gradeResultsCalls).toBe(2);

    // Verify table structure
    const tableRows = logs.filter(l => l.startsWith('|'));
    expect(tableRows.length).toBeGreaterThanOrEqual(4); // Header, Separator, agent1, agent2
    
    expect(tableRows[0]).toContain('| Agent | T4 | T5 | T6 | T7 | T8 | Net | Latency p50 |');
    
    const cloud1Row = tableRows.find(r => r.includes('cloud-1'))!;
    expect(cloud1Row).toContain('✅'); // T4 passed
    expect(cloud1Row).toContain('🛑'); // Others failed
    expect(cloud1Row).toContain('1/5'); // Net score
    expect(cloud1Row).toContain('300ms'); // p50 of [100, 200, 300, 400, 500] is 300
  } finally {
    console.log = originalLog;
  }
});

test('runFleetBench: honors include/exclude filters', async () => {
  runBenchCalls = 0;
  
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    await runFleetBench({ include: /cloud-1/, skipGrade: true });
    expect(runBenchCalls).toBe(1);

    runBenchCalls = 0;
    await runFleetBench({ exclude: /cloud-2/, skipGrade: true });
    expect(runBenchCalls).toBe(1);
  } finally {
    console.log = originalLog;
  }
});

test('runFleetBench: respects skipGrade flag', async () => {
  gradeResultsCalls = 0;
  
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    await runFleetBench({ skipGrade: true });
    expect(gradeResultsCalls).toBe(0);
    
    const cloud1Row = logs.find(r => r.includes('cloud-1'))!;
    expect(cloud1Row).toContain('- | - | - | - | -'); // No emojis when skipping grade
    expect(cloud1Row).toContain('N/A');
  } finally {
    console.log = originalLog;
  }
});
