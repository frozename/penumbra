import { z } from 'zod';
import { LaneCloseMetadataSchema, type LaneCloseMetadata } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const LaneCloseInputShape = {
  lane_id: z.string().min(1),
  gate_status: z.enum(['passed', 'failed', 'skipped', 'review_debt']),
  reviewer_handoff_id: z.string().min(1).optional(),
  override_reason: z.string().min(1).optional(),
  metadata: LaneCloseMetadataSchema.optional(),
};

export function laneCloseHandler(daemon: DaemonClient) {
  return async (input: {
    lane_id: string;
    gate_status: 'passed' | 'failed' | 'skipped' | 'review_debt';
    reviewer_handoff_id?: string;
    override_reason?: string;
    metadata?: LaneCloseMetadata;
  }) => {
    const response = await postToDaemon(daemon, '/lanes/close', {
      lane_id: input.lane_id,
      gate_status: input.gate_status,
      reviewer_handoff: input.reviewer_handoff_id,
      override_reason: input.override_reason,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    }) as {
      lane_id: string;
      gate_status: 'passed' | 'failed' | 'skipped' | 'review_debt';
      implementer_handoff?: string | null;
      reviewer_handoff?: string | null;
    };

    if (response.gate_status !== 'skipped' && response.gate_status !== 'review_debt') {
      if (!response.implementer_handoff || !response.reviewer_handoff) {
        throw new Error('daemon /lanes/close: missing implementer_handoff or reviewer_handoff in response');
      }
      await postToDaemon(daemon, '/memory-verify/authorize', {
        handoff_id: response.implementer_handoff,
        verdict: response.gate_status,
        basis: {
          kind: 'lane_close',
          lane_id: response.lane_id,
          reviewer_handoff: response.reviewer_handoff,
        },
        authorized_by_handoff: response.reviewer_handoff,
      });
    }

    return response as { lane_id: string; gate_status: string };
  };
}

async function postToDaemon(daemon: DaemonClient, path: string, body: unknown): Promise<unknown> {
  const { baseUrl, token } = (daemon as unknown as { resolve: () => { baseUrl: string; token: string } }).resolve();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await daemonHttpError(path, res);
  return await res.json();
}

async function daemonHttpError(path: string, res: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {}
  return new Error(`daemon ${path}: HTTP ${res.status}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
}
