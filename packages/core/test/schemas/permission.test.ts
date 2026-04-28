import { describe, expect, it } from 'bun:test';
import {
  PermissionStatusSchema,
  PermissionRequestRowSchema,
  CreatePermissionRequestSchema,
  ApprovePermissionRequestSchema,
} from '../../src/schemas/permission.js';

describe('PermissionStatusSchema', () => {
  it('accepts the four lifecycle states', () => {
    for (const s of ['pending', 'approved', 'rejected', 'expired'] as const) {
      expect(() => PermissionStatusSchema.parse(s)).not.toThrow();
    }
  });
  it('rejects unknown statuses', () => {
    expect(() => PermissionStatusSchema.parse('cancelled')).toThrow();
  });
});

describe('PermissionRequestRowSchema', () => {
  it('parses a valid pending row', () => {
    const row = {
      permission_id: 'perm-1',
      parent_handoff_id: 'h-1',
      conversation_id: 'conv-1',
      agent_name: 'claude-acp-sonnet',
      tool_name: 'fs.readTextFile',
      raw_input_json: '{"path":"src/foo.ts"}',
      status: 'pending',
      remember_scope: null,
      decision_reason: null,
      decided_by: null,
      ttl_at: '2026-04-28T12:05:00.000Z',
      created_at: '2026-04-28T12:00:00.000Z',
      decided_at: null,
    };
    expect(() => PermissionRequestRowSchema.parse(row)).not.toThrow();
  });
});

describe('CreatePermissionRequestSchema', () => {
  it('requires all non-optional fields', () => {
    const ok = {
      permission_id: 'perm-1',
      parent_handoff_id: 'h-1',
      conversation_id: 'conv-1',
      agent_name: 'claude-acp-sonnet',
      tool_name: 'fs.readTextFile',
      raw_input: { path: 'src/foo.ts' },
    };
    expect(() => CreatePermissionRequestSchema.parse(ok)).not.toThrow();
  });
  it('rejects missing permission_id', () => {
    expect(() => CreatePermissionRequestSchema.parse({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {},
    })).toThrow();
  });
  it('accepts optional ttl_seconds', () => {
    expect(() => CreatePermissionRequestSchema.parse({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 600,
    })).not.toThrow();
  });
});

describe('ApprovePermissionRequestSchema', () => {
  it('requires decision', () => {
    expect(() => ApprovePermissionRequestSchema.parse({})).toThrow();
  });
  it('accepts approve with this_dispatch remember', () => {
    expect(() => ApprovePermissionRequestSchema.parse({
      decision: 'approve', remember: 'this_dispatch',
    })).not.toThrow();
  });
  it('rejects an unknown remember scope', () => {
    expect(() => ApprovePermissionRequestSchema.parse({
      decision: 'approve', remember: 'forever',
    })).toThrow();
  });
});
