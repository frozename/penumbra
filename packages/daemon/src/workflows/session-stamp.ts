import type { Services } from "@penumbra/core";

import {
  resolveTemplateVars,
  type TemplateVarContext,
  type WorkflowSpec,
} from "@penumbra/workflows";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

export const SESSION_STAMP_RE =
  /^<!--\s*penumbra:session\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/i;
const SKELETON_STAMP_READ_LIMIT_BYTES = 4096;

type ContinuityTrigger = "hook" | "run" | "refresh";

type SessionHandoffContinuityOpts = {
  services: Services;
  cwd: string;
  project: string;
  specName: string;
  artifacts: string[];
  transcriptPath: string | null;
  sessionId: string | null;
  trigger: ContinuityTrigger;
};

type ContinuityOutcome = {
  session_stamp: string | null;
};

export function sessionStampFromBodyPrefix(body: string): string | null {
  const lines = body.split(/\r?\n/, 5);
  for (const line of lines) {
    const match = SESSION_STAMP_RE.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

function readSkeletonStampPrefix(path: string): string {
  const buffer = Buffer.alloc(SKELETON_STAMP_READ_LIMIT_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sessionStampFromSkeletonBody(body: string): string | null {
  return sessionStampFromBodyPrefix(body);
}

function periodKeyFromSkeletonPath(path: string): string | null {
  const match = /^maestro-continuation-(.+)\.skeleton\.md$/.exec(basename(path));
  return match?.[1] ?? null;
}

function statIfExists(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function resolveSessionHandoffArtifactPath(opts: {
  spec: WorkflowSpec;
  templateCtx: TemplateVarContext;
  repoRoot: string;
}): string | null {
  for (const sink of opts.spec.output) {
    if (sink.kind !== "file") continue;
    const rendered = resolveTemplateVars(sink.path, opts.templateCtx);
    const path = resolve(opts.repoRoot, rendered);
    if (!periodKeyFromSkeletonPath(path)) continue;
    return path;
  }
  return null;
}

export function resolveSessionHandoffTemplateCtx(opts: {
  spec: WorkflowSpec;
  templateCtx: TemplateVarContext;
  repoRoot: string;
}): { templateCtx: TemplateVarContext; sessionStamp: string | null } {
  if (opts.templateCtx.sessionId) {
    return { templateCtx: opts.templateCtx, sessionStamp: opts.templateCtx.sessionId };
  }
  const artifactPath = resolveSessionHandoffArtifactPath(opts);
  if (!artifactPath) return { templateCtx: opts.templateCtx, sessionStamp: null };
  const stat = statIfExists(artifactPath);
  if (!stat) return { templateCtx: opts.templateCtx, sessionStamp: null };
  const stamp = sessionStampFromSkeletonBody(readSkeletonStampPrefix(artifactPath));
  if (!stamp) return { templateCtx: opts.templateCtx, sessionStamp: null };
  return {
    templateCtx: { ...opts.templateCtx, sessionId: stamp },
    sessionStamp: stamp,
  };
}

export function hydrateSessionHandoffTemplateCtx(opts: {
  name: string;
  spec: WorkflowSpec;
  templateCtx: TemplateVarContext;
  repoRoot: string;
}): { templateCtx: TemplateVarContext; sessionStamp: string | null } {
  if (opts.name !== "session-handoff") {
    return { templateCtx: opts.templateCtx, sessionStamp: null };
  }
  return resolveSessionHandoffTemplateCtx({
    spec: opts.spec,
    templateCtx: opts.templateCtx,
    repoRoot: opts.repoRoot,
  });
}

function continuityMetaBase(sessionStamp: string | null): ContinuityOutcome {
  return { session_stamp: sessionStamp };
}

function recordContinuityRow(opts: {
  services: Services;
  sessionId: string | null;
  relatedSessionId: string | null;
  project: string;
  cwd: string;
  transcriptPath: string | null;
  refPath: string;
  kind: "continuity.skeleton_generated" | "continuity.note_superseded";
  meta: Record<string, unknown> | null;
}): void {
  opts.services.sessionEventLog.record({
    session_id: opts.sessionId,
    related_session_id: opts.relatedSessionId,
    project_id: opts.project !== "unknown" ? opts.project : null,
    cwd: opts.cwd,
    transcript_path: opts.transcriptPath,
    ref_path: opts.refPath,
    kind: opts.kind,
    ts: opts.services.clock().toISOString(),
    meta: opts.meta,
  });
}

export function recordContinuitySessionEvents(opts: SessionHandoffContinuityOpts): void {
  if (opts.specName !== "session-handoff") return;
  const skeletonArtifact = opts.artifacts.find((artifact) => periodKeyFromSkeletonPath(artifact));
  if (!skeletonArtifact) return;
  const skeletonPath = resolve(skeletonArtifact);
  const periodKey = periodKeyFromSkeletonPath(skeletonPath);
  if (periodKey === null) return;
  try {
    const skeletonStampPrefix = readSkeletonStampPrefix(skeletonPath);
    const skeletonStat = statSync(skeletonPath);
    recordContinuityRow({
      services: opts.services,
      sessionId: opts.sessionId,
      relatedSessionId: null,
      project: opts.project,
      cwd: opts.cwd,
      transcriptPath: opts.transcriptPath,
      refPath: skeletonPath,
      kind: "continuity.skeleton_generated",
      meta: {
        ...continuityMetaBase(sessionStampFromSkeletonBody(skeletonStampPrefix)),
        byte_size: skeletonStat.size,
        period_key: periodKey,
        trigger: opts.trigger,
      },
    });

    const barePath = skeletonPath.replace(/\.skeleton\.md$/, ".md");
    const bareStat = statIfExists(barePath);
    if (!bareStat || bareStat.mtime.getTime() <= skeletonStat.mtime.getTime()) return;
    recordContinuityRow({
      services: opts.services,
      sessionId: opts.sessionId,
      relatedSessionId: null,
      project: opts.project,
      cwd: opts.cwd,
      transcriptPath: opts.transcriptPath,
      refPath: barePath,
      kind: "continuity.note_superseded",
      meta: {
        skeleton_path: skeletonPath,
        note_mtime: bareStat.mtime.toISOString(),
        skeleton_mtime: skeletonStat.mtime.toISOString(),
        trigger: opts.trigger,
      },
    });
  } catch (err) {
    opts.services.log.warn(
      { err, kind: "continuity.skeleton_generated" },
      "continuity session event ingest failed; continuing workflow hook",
    );
  }
}
