import { expect, it, describe } from 'bun:test';
import { sanitizeTitleForQuery } from '../../src/dreaming/query-sanitize.js';

describe('dreaming/query-sanitize', () => {
  it('returns null for URL-like prefixes', () => {
    expect(sanitizeTitleForQuery('https://attacker.com/exfil')).toBeNull();
    expect(sanitizeTitleForQuery('file:///etc/passwd')).toBeNull();
    expect(sanitizeTitleForQuery('javascript:alert(1)')).toBeNull();
    expect(sanitizeTitleForQuery('data:text/plain,hello')).toBeNull();
    expect(sanitizeTitleForQuery('ftp://evil.com')).toBeNull();
  });

  it('returns null for control characters', () => {
    expect(sanitizeTitleForQuery('topic\x00name')).toBeNull();
  });

  it('returns null when trimmed length is 0 or exceeds 200', () => {
    expect(sanitizeTitleForQuery('   ')).toBeNull();
    expect(sanitizeTitleForQuery('a'.repeat(201))).toBeNull();
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeTitleForQuery('  spaced topic  ')).toBe('spaced topic');
  });

  it('passes through valid title', () => {
    expect(sanitizeTitleForQuery('research topic')).toBe('research topic');
  });
});
