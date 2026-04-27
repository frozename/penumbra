import { expect, test } from 'bun:test';
import { runGrade } from './bench-grade.js';
import { writeFileSync, unlinkSync } from 'node:fs';

test('runGrade: parses JSONL and dispatches grading prompts to mock HTTP', async () => {
  const jsonlPath = 'test-bench-results.jsonl';
  const testEntries = [
    { task: 'T4', answer: '4', model: 'test-model', label: 'test-run' },
    { task: 'T5', answer: 'blocks in queue', model: 'test-model', label: 'test-run' },
    { task: 'T6', answer: 'NO_BUGS', model: 'test-model', label: 'test-run' },
    { task: 'T7', answer: '2', model: 'test-model', label: 'test-run' },
    { task: 'T8', answer: 'both', model: 'test-model', label: 'test-run' },
  ];
  writeFileSync(jsonlPath, testEntries.map(e => JSON.stringify(e)).join('\n'));

  let callCount = 0;
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    callCount++;
    const req = input instanceof Request ? input : new Request(String(input), init);
    const body = await req.json();
    expect(body.messages[0].content).toContain('GROUND TRUTH:');
    expect(body.messages[0].content).toContain('MODEL ANSWER:');

    return new Response(JSON.stringify({
      choices: [{ message: { content: 'PASS' } }]
    }), { headers: { 'content-type': 'application/json' } });
  }) as any;

  try {
    const url = `http://stub/v1`;
    const results = await runGrade({
      inputPath: jsonlPath,
      url,
      model: 'judge-model',
      fetch: fetchImpl,
    });

    expect(results.length).toBe(5);
    expect(callCount).toBe(5);
    for (const r of results) {
      expect(r.verdict).toBe('PASS');
      expect(r.model).toBe('test-model');
      expect(r.label).toBe('test-run');
    }
  } finally {
    unlinkSync(jsonlPath);
  }
});

test('runGrade: handles PARTIAL and FAIL verdicts correctly', async () => {
  const jsonlPath = 'test-bench-mixed.jsonl';
  writeFileSync(jsonlPath, JSON.stringify({ task: 'T4', answer: 'maybe', model: 'm', label: 'l' }));

  let call = 0;
  const fetchImpl: typeof fetch = (async () => {
    call++;
    const content = call === 1 ? 'PARTIAL verdict' : 'totally WRONG';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }]
    }), { headers: { 'content-type': 'application/json' } });
  }) as any;

  try {
    const url = `http://stub/v1`;
    const results = await runGrade({ inputPath: jsonlPath, url, model: 'j', fetch: fetchImpl });
    expect(results[0].verdict).toBe('PARTIAL');
  } finally {
    unlinkSync(jsonlPath);
  }
});
