import type { WorkingMemory } from './types.js';

export const THREAD_NOTES_MAX_CHARS = parseInt(
  process.env.PENUMBRA_LONG_LIVED_THREAD_NOTES_MAX_CHARS ?? '4096',
  10,
);

const BANNER = '... (older entries truncated)\n';

export function trimThreadNotes(notes: string, maxChars: number = THREAD_NOTES_MAX_CHARS): string {
  if (notes.length <= maxChars) return notes;
  const effectiveMax = Math.max(0, maxChars - BANNER.length);
  const tail = notes.slice(-effectiveMax);
  const nlIdx = tail.indexOf('\n');
  const aligned = nlIdx === -1 ? tail : tail.slice(nlIdx + 1);
  return BANNER + aligned;
}

export function trimWorkingMemoryThreadNotes(
  wm: WorkingMemory,
  maxChars?: number,
): WorkingMemory {
  if (!wm.open_threads.some((t) => t.notes.length > (maxChars ?? THREAD_NOTES_MAX_CHARS))) {
    return wm;
  }
  return {
    ...wm,
    open_threads: wm.open_threads.map((t) => ({
      ...t,
      notes: trimThreadNotes(t.notes, maxChars),
    })),
  };
}
