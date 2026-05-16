import { describe, expect, it, test } from 'bun:test';
import {
  parseTaskDraftLifecyclePayload,
  TaskDraftPayloadSchema,
  TaskDraftRefiningPayloadSchema,
  TaskDraftPromotedPayloadSchema,
  TaskDraftStalePayloadSchema,
  TaskDraftDuplicatePayloadSchema,
  TaskDraftEscalationPayloadSchema,
} from '../../src/schemas/task-draft.js';
import { TASK_DRAFT_LIFECYCLE_EVENT_TYPES } from '../../src/schemas/event.js';

const baseDraftPayload = {
  draft_id: '11111111-1111-4111-8111-111111111111',
  prompt: 'Investigate the bug.',
  affects_projects: ['project-a'],
  evidence: {
    conv_ids: ['conv-1'],
    commits: ['abc123'],
    files: ['file.ts'],
    session_id: 'sess-1',
  },
  auto_ok: true,
  filed_by_agent: 'agent-a',
  filed_via: 'stop_hook' as const,
  parent_draft_id: null,
};

test('parses task_draft payload', () => {
  expect(() => TaskDraftPayloadSchema.parse(baseDraftPayload)).not.toThrow();
});

test('parses task_draft_refining payload', () => {
  expect(() => TaskDraftRefiningPayloadSchema.parse({ draft_id: baseDraftPayload.draft_id })).not.toThrow();
});

test('parses task_draft_promoted payload', () => {
  expect(() => TaskDraftPromotedPayloadSchema.parse({
    draft_id: baseDraftPayload.draft_id,
    task_ids: ['task-1', 'task-2'],
  })).not.toThrow();
});

test('parses task_draft_stale payload', () => {
  expect(() => TaskDraftStalePayloadSchema.parse({
    draft_id: baseDraftPayload.draft_id,
    stale_reason: 'path_removed',
  })).not.toThrow();
});

test('parses task_draft_duplicate payload', () => {
  expect(() => TaskDraftDuplicatePayloadSchema.parse({
    draft_id: baseDraftPayload.draft_id,
    duplicate_of_task_id: 'task-123',
  })).not.toThrow();
});

test('parses task_draft_escalation payload', () => {
  expect(() => TaskDraftEscalationPayloadSchema.parse({
    draft_id: baseDraftPayload.draft_id,
    escalation_reason: 'requires human review',
  })).not.toThrow();
});

describe('parseTaskDraftLifecyclePayload', () => {
  for (const eventType of TASK_DRAFT_LIFECYCLE_EVENT_TYPES) {
    it(`parses ${eventType}`, () => {
      const payload = eventType === 'task_draft'
        ? baseDraftPayload
        : eventType === 'task_draft_refining'
          ? { draft_id: baseDraftPayload.draft_id }
          : eventType === 'task_draft_promoted'
            ? { draft_id: baseDraftPayload.draft_id, task_ids: ['task-1'] }
            : eventType === 'task_draft_stale'
              ? { draft_id: baseDraftPayload.draft_id, stale_reason: 'ttl_expired' }
              : eventType === 'task_draft_duplicate'
                ? { draft_id: baseDraftPayload.draft_id, duplicate_of_task_id: 'task-123' }
                : { draft_id: baseDraftPayload.draft_id, escalation_reason: 'manual handoff' };
      expect(() => parseTaskDraftLifecyclePayload(eventType, payload)).not.toThrow();
    });
  }

  it('rejects missing draft_id for task_draft', () => {
    expect(() => TaskDraftPayloadSchema.parse({
      ...baseDraftPayload,
      draft_id: undefined,
    } as unknown)).toThrow();
  });

  it('rejects non-uuid draft_id for task_draft_refining', () => {
    expect(() => TaskDraftRefiningPayloadSchema.parse({
      draft_id: 'not-a-uuid',
    })).toThrow();
  });

  it('rejects task_draft_promoted with empty task_ids', () => {
    expect(() => TaskDraftPromotedPayloadSchema.parse({
      draft_id: baseDraftPayload.draft_id,
      task_ids: [],
    })).toThrow();
  });

  it('rejects task_draft_stale with bogus stale_reason', () => {
    expect(() => TaskDraftStalePayloadSchema.parse({
      draft_id: baseDraftPayload.draft_id,
      stale_reason: 'unsupported',
    } as unknown)).toThrow();
  });

  it('rejects task_draft with empty affects_projects', () => {
    expect(() => TaskDraftPayloadSchema.parse({
      ...baseDraftPayload,
      affects_projects: [],
    })).toThrow();
  });

  it('rejects task_draft with auto_ok not boolean', () => {
    expect(() => TaskDraftPayloadSchema.parse({
      ...baseDraftPayload,
      auto_ok: 'true',
    } as unknown)).toThrow();
  });

  it('accepts task_draft with provenance field', () => {
    const payload = {
      ...baseDraftPayload,
      provenance: {
        filing_path: 'stop_hook',
        session_id: 'sess-1',
        extractor_version: 'v1',
        filtered_by: ['source_allowlist', 'type_allowlist', 'time_window'],
      },
    };
    expect(() => TaskDraftPayloadSchema.parse(payload)).not.toThrow();
    const parsed = TaskDraftPayloadSchema.parse(payload);
    expect(parsed.provenance?.filing_path).toBe('stop_hook');
    expect(parsed.provenance?.session_id).toBe('sess-1');
  });

  it('accepts task_draft without provenance (backward compat)', () => {
    expect(() => TaskDraftPayloadSchema.parse(baseDraftPayload)).not.toThrow();
    const parsed = TaskDraftPayloadSchema.parse(baseDraftPayload);
    expect(parsed.provenance).toBeUndefined();
  });
});
