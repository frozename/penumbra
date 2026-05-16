import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractStumblesFromSession, type SessionEventRow } from '../../src/services/stumble-extractor.js';

describe('extractStumblesFromSession', () => {
  test('empty transcript returns []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stumble-empty-'));
    try {
      const out = await extractStumblesFromSession({ session_id: 's-1', transcript_path: join(dir, 'missing.txt') });
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TODO line yields one candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stumble-todo-'));
    try {
      const transcript = join(dir, 'transcript.txt');
      writeFileSync(transcript, 'TODO: audit X before shipping\n');

      const out = await extractStumblesFromSession({ session_id: 's-2', transcript_path: transcript });
      expect(out).toHaveLength(1);
      expect(out[0]?.prompt).toContain('TODO: audit X');
      expect(out[0]?.evidence.session_id).toBe('s-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolver output wins over default project and empty default leaves affects_projects empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stumble-projects-'));
    try {
      const transcript = join(dir, 'transcript.txt');
      writeFileSync(transcript, 'TODO: audit X before shipping\n');

      const resolved = await extractStumblesFromSession({
        session_id: 's-2a',
        transcript_path: transcript,
        default_project: 'fallback-project',
        affects_projects_resolver: () => ['resolved-a', 'resolved-b'],
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.affects_projects).toEqual(['resolved-a', 'resolved-b']);

      const emptyDefault = await extractStumblesFromSession({
        session_id: 's-2b',
        transcript_path: transcript,
      });
      expect(emptyDefault).toHaveLength(1);
      expect(emptyDefault[0]?.affects_projects).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inline-filed task_draft in the session filters the duplicate transcript stumble', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stumble-dedupe-'));
    try {
      const transcript = join(dir, 'transcript.txt');
      writeFileSync(transcript, 'TODO: audit X before shipping!\n');
      const events: SessionEventRow[] = [
        {
          event_type: 'task_draft',
          payload_json: {
            prompt: ' todo:   audit X   before shipping. ',
          },
        },
      ];

      const out = await extractStumblesFromSession({
        session_id: 's-3',
        transcript_path: transcript,
        dispatch_events_query: async () => events,
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repeated transcript lines dedupe within the same batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stumble-repeat-'));
    try {
      const transcript = join(dir, 'transcript.txt');
      writeFileSync(transcript, 'TODO: audit X before shipping.\nTODO: audit X before shipping!\n');

      const out = await extractStumblesFromSession({ session_id: 's-4', transcript_path: transcript });
      expect(out).toHaveLength(1);
      expect(out[0]?.prompt).toBe('TODO: audit X before shipping.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
