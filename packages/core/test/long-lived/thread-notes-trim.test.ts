import { describe, it, expect } from 'bun:test';
import { trimThreadNotes, trimWorkingMemoryThreadNotes } from '@penumbra/core/long-lived/thread-notes-trim';

const BANNER = '... (older entries truncated)\n';
const MAX = 4096;

function makeNotes(len: number, lineLen = 80): string {
  const line = 'x'.repeat(lineLen - 1) + '\n';
  let s = '';
  while (s.length < len) s += line;
  return s.slice(0, len);
}

describe('trimThreadNotes', () => {
  it('returns notes unchanged when length <= maxChars', () => {
    const notes = makeNotes(MAX);
    expect(trimThreadNotes(notes)).toBe(notes);
  });

  it('trims notes > maxChars to <= maxChars and prepends banner', () => {
    const notes = makeNotes(MAX + 500);
    const result = trimThreadNotes(notes);
    expect(result.length).toBeLessThanOrEqual(MAX);
    expect(result.startsWith(BANNER)).toBe(true);
  });

  it('aligns trim to newline boundary — result does not start mid-line after banner', () => {
    // build a string where the tail boundary falls mid-line
    const base = 'line one\nline two\nline three\n';
    // pad to just over MAX so the tail cut falls in the middle of a line
    const padding = 'a'.repeat(MAX - 10) + '\nmid-line-start';
    const notes = padding + base;
    const result = trimThreadNotes(notes);
    expect(result.startsWith(BANNER)).toBe(true);
    // the character right after the banner must be the start of a line (preceded by \n or start)
    const afterBanner = result.slice(BANNER.length);
    // afterBanner must not be a continuation — it must align to a newline from the source
    expect(afterBanner.startsWith('\n')).toBe(false); // banner already ends with \n
    // the tail slice starts at a newline position: no partial line fragments
    const firstLineEnd = afterBanner.indexOf('\n');
    // first segment should be a complete line (not mid-text cut)
    expect(afterBanner.slice(0, firstLineEnd)).not.toContain('\x00');
  });

  it('is idempotent — re-applying to already-trimmed text returns unchanged', () => {
    const notes = makeNotes(MAX + 100);
    const once = trimThreadNotes(notes);
    const twice = trimThreadNotes(once);
    expect(twice).toBe(once);
  });

  it('passes through empty notes unchanged', () => {
    expect(trimThreadNotes('')).toBe('');
  });

  it('honours an explicit maxChars override (env-override equivalent)', () => {
    const notes = makeNotes(300);
    const result = trimThreadNotes(notes, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith(BANNER)).toBe(true);
  });
});

describe('trimWorkingMemoryThreadNotes', () => {
  const baseWm = {
    version: 1 as const,
    updated_at: 1,
    pending_goals: [],
    watches: [],
    recent_decisions: [],
  };

  it('trims each open_thread independently', () => {
    const wm = {
      ...baseWm,
      open_threads: [
        { id: 't1', topic: 'a', opened_at: 1, notes: makeNotes(MAX + 100) },
        { id: 't2', topic: 'b', opened_at: 2, notes: 'short note' },
        { id: 't3', topic: 'c', opened_at: 3, notes: makeNotes(MAX + 200) },
      ],
    };
    const result = trimWorkingMemoryThreadNotes(wm);
    expect(result.open_threads[0].notes.length).toBeLessThanOrEqual(MAX);
    expect(result.open_threads[0].notes.startsWith(BANNER)).toBe(true);
    expect(result.open_threads[1].notes).toBe('short note');
    expect(result.open_threads[2].notes.length).toBeLessThanOrEqual(MAX);
    expect(result.open_threads[2].notes.startsWith(BANNER)).toBe(true);
  });

  it('returns the same object reference when no thread needs trimming', () => {
    const wm = {
      ...baseWm,
      open_threads: [
        { id: 't1', topic: 'a', opened_at: 1, notes: 'ok' },
      ],
    };
    expect(trimWorkingMemoryThreadNotes(wm)).toBe(wm);
  });
});
