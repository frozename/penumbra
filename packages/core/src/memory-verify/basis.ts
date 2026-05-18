import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Services } from '../services.js';

const LaneCloseBasisSchema = z.object({
  kind: z.literal('lane_close'),
  lane_id: z.string().min(1),
  reviewer_handoff: z.string().min(1),
});

const DispatchLandBasisSchema = z.object({
  kind: z.literal('dispatch_land'),
  merge_commit: z.string().min(7).max(40).regex(/^[a-f0-9]+$/),
  reviewer_handoff: z.string().min(1),
});

const AdversarialReviewBasisSchema = z.object({
  kind: z.literal('adversarial_review'),
  synthesis_path: z.string().min(1),
  synthesizer_handoff: z.string().min(1),
});

const ManualOverrideBasisSchema = z.object({
  kind: z.literal('manual_override'),
  reason: z.string().min(1),
  authorized_by: z.string().min(1),
});

export const BasisSchema = z.discriminatedUnion('kind', [
  LaneCloseBasisSchema,
  DispatchLandBasisSchema,
  AdversarialReviewBasisSchema,
  ManualOverrideBasisSchema,
]);

export type Basis = z.infer<typeof BasisSchema>;

function getMainRepoDir(services: Services): string {
  return (services.worktreeManager as unknown as { mainRepoDir?: string }).mainRepoDir ?? process.cwd();
}

function getReviewDir(services: Services): string {
  return services.reviewsDir;
}

async function validateAdversarialReviewPath(
  services: Services,
  synthesisPath: string,
): Promise<{ ok: true; realpath: string } | { ok: false; status: 400; reason: string }> {
  const reviewsDir = getReviewDir(services);
  if (synthesisPath.split(/[\\/]/).includes('..')) {
    return { ok: false, status: 400, reason: 'synthesis_path contains traversal' };
  }
  if (path.isAbsolute(synthesisPath)) {
    if (!synthesisPath.startsWith(reviewsDir + path.sep) && synthesisPath !== reviewsDir) {
      return { ok: false, status: 400, reason: 'synthesis_path must stay within reviews dir' };
    }
  }
  const resolved = path.resolve(reviewsDir, synthesisPath);
  const canonicalReviewsDir = await realpath(reviewsDir);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolved);
  } catch {
    return { ok: false, status: 400, reason: 'synthesis_path does not exist' };
  }
  const prefix = canonicalReviewsDir.endsWith(path.sep) ? canonicalReviewsDir : `${canonicalReviewsDir}${path.sep}`;
  if (canonicalPath !== canonicalReviewsDir && !canonicalPath.startsWith(prefix)) {
    return { ok: false, status: 400, reason: 'synthesis_path escapes reviews dir' };
  }
  return { ok: true, realpath: canonicalPath };
}

export async function validateBasis(
  services: Services,
  basis: Basis,
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 404; reason: string }> {
  switch (basis.kind) {
    case 'lane_close': {
      const lane = services.db.query<{
        implementer_handoff: string;
        reviewer_handoff: string | null;
        ts_closed: string | null;
      }, [string]>(
        `SELECT implementer_handoff, reviewer_handoff, ts_closed FROM lane_ledger WHERE lane_id = ?`,
      ).get(basis.lane_id);
      if (!lane) return { ok: false, status: 404, reason: 'lane not found' };
      if (lane.ts_closed === null) return { ok: false, status: 400, reason: 'lane is not closed' };
      if (lane.reviewer_handoff !== basis.reviewer_handoff) {
        return { ok: false, status: 403, reason: 'reviewer handoff does not match lane ledger' };
      }
      if (lane.implementer_handoff === lane.reviewer_handoff) {
        return { ok: false, status: 403, reason: 'reviewer must differ from implementer' };
      }
      return { ok: true };
    }
    case 'dispatch_land': {
      const mainRepoDir = getMainRepoDir(services);
      const handoff = services.db.query<{
        from_agent: string;
        to_agent: string;
      }, [string]>(
        `SELECT from_agent, to_agent FROM handoffs WHERE handoff_id = ?`,
      ).get(basis.reviewer_handoff);
      if (!handoff) return { ok: false, status: 404, reason: 'handoff not found' };
      if (handoff.from_agent === handoff.to_agent) {
        return { ok: false, status: 403, reason: 'reviewer must differ from implementer' };
      }
      const proc = spawnSync('git', ['-C', mainRepoDir, 'cat-file', '-e', basis.merge_commit], { encoding: 'utf8' });
      if (proc.status !== 0) return { ok: false, status: 404, reason: 'merge commit not found' };
      return { ok: true };
    }
    case 'adversarial_review': {
      const pathResult = await validateAdversarialReviewPath(services, basis.synthesis_path);
      if (!pathResult.ok) return pathResult;
      const synth = services.handoffReader.get(basis.synthesizer_handoff);
      if (!synth) return { ok: false, status: 404, reason: 'synthesizer handoff not found' };
      const chainTaskType = (synth as unknown as { chain_task_type?: string | null }).chain_task_type ?? null;
      if (chainTaskType !== 'review_adversarial' && chainTaskType !== 'adversarial_review_synthesis') {
        return { ok: false, status: 403, reason: 'synthesizer handoff has wrong task type' };
      }
      return { ok: true };
    }
    case 'manual_override': {
      const reason = basis.reason.trim();
      const authorizedBy = basis.authorized_by.trim();
      if (!reason) return { ok: false, status: 400, reason: 'reason is required' };
      if (!authorizedBy) return { ok: false, status: 400, reason: 'authorized_by is required' };
      services.log.warn({ authorized_by: authorizedBy }, 'memory verify manual override authorized');
      return { ok: true };
    }
  }
}
