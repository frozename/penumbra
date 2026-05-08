import { expect, test } from 'bun:test';
import { formatPenumbraComment, isPenumbraAuthoredComment } from '../../src/services/gh-comment-format.js';

test('formatPenumbraComment includes parseable marker line', () => {
  const body = formatPenumbraComment({
    task_id: 'task_123',
    kind: 'status_change',
    ts: '2026-05-08T16:00:00.000Z',
    status_transition: {
      from_status: 'pending',
      to_status: 'leased',
    },
  });

  const firstLine = body.split('\n')[0] ?? '';
  expect(firstLine).toBe('<!-- penumbra:source=task:task_123 kind=status_change ts=2026-05-08T16:00:00.000Z -->');
  expect(isPenumbraAuthoredComment(body)).toBe(true);
});
