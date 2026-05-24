import { describe, expect, it } from 'bun:test';
import {
  FEW_SHOT_EXAMPLES,
  REWRITE_RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
} from '../../src/dreaming/dream-rewriter-prompt-content.js';
import { buildDreamQueryRewritePrompt } from '../../src/dreaming/dream-rewriter-prompt.js';

interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

describe('dream rewriter prompt content', () => {
  it('validates few-shot example outputs against schema', () => {
    for (const example of FEW_SHOT_EXAMPLES) {
      const parsed = REWRITE_RESPONSE_SCHEMA.safeParse(example.output);
      expect(parsed.success).toBe(true);
    }
  });

  it('contains required system prompt invariants', () => {
    expect(SYSTEM_PROMPT).toContain('query');
    expect(SYSTEM_PROMPT).toContain('skip');
    expect(SYSTEM_PROMPT).toContain('reason');
    expect(SYSTEM_PROMPT).toContain('JSON');
  });

  it('keeps few-shot count within the expected range', () => {
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(4);
    expect(FEW_SHOT_EXAMPLES.length).toBeLessThanOrEqual(6);
  });

  it('prompt builder emits alternating role messages plus final user input', () => {
    const input = {
      title: 'Test-driven development workflow for engine registry',
      bodyFirst200: 'Postmortem notes described how we added new registries and kept behavior stable by writing tests first.',
    };
    const messages = buildDreamQueryRewritePrompt(input);
    const expectedMessageCount = 1 + FEW_SHOT_EXAMPLES.length * 2 + 1;

    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(expectedMessageCount);

    const [systemMessage, ...rest] = messages as PromptMessage[];
    expect(systemMessage.role).toBe('system');
    for (let i = 0; i < FEW_SHOT_EXAMPLES.length; i++) {
      expect(rest[i * 2].role).toBe('user');
      expect(rest[i * 2 + 1].role).toBe('assistant');
    }

    const final = messages[messages.length - 1] as PromptMessage;
    expect(final.role).toBe('user');
    expect(final.content).toContain(input.title);
    expect(final.content).toContain(input.bodyFirst200);
  });

  it('rejects invalid rewrite responses', () => {
    expect(REWRITE_RESPONSE_SCHEMA.safeParse({ kind: 'query' }).success).toBe(false);
    expect(REWRITE_RESPONSE_SCHEMA.safeParse({ kind: 'skip', reason: '' }).success).toBe(false);
    expect(REWRITE_RESPONSE_SCHEMA.safeParse({ kind: 'unknown', x: 1 }).success).toBe(false);
  });
});
