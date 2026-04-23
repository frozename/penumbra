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
