import type { Logger } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { randomUUID } from "node:crypto";

import { extractActionTarget } from "./target-extractors.js";

type ActionGateRequest = Parameters<ActionGate["handleCall"]>[0];
type ActionGateResult = Awaited<ReturnType<ActionGate["handleCall"]>>;

type AgentGateConfig = {
  mcp_allowlist_json: string;
  approval_required_globs_json: string;
  cooldown_overrides_json: string;
};

const BASELINE_TIERS: { match: RegExp; tier: 1 | 2 | 3 }[] = [
  { match: /^ha:state\./, tier: 1 },
  { match: /^ha:(light|switch|climate)\./, tier: 1 },
  { match: /^ha:script\.run$/, tier: 1 },
  { match: /^ha:snapshot\.(create|list)$/, tier: 1 },
  { match: /^ha:dashboard\./, tier: 2 },
  { match: /^ha:automation\.(set|delete)$/, tier: 2 },
  { match: /^ha:snapshot\.restore$/, tier: 2 },
  { match: /^ha:integration\./, tier: 3 },
];

function baselineTier(tool: string): 1 | 2 | 3 {
  for (const rule of BASELINE_TIERS) {
    if (rule.match.test(tool)) return rule.tier;
  }
  return 1;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function targetVariants(target: string): string[] {
  const variants = [target];
  const dotIndex = target.indexOf(".");
  if (dotIndex >= 0 && dotIndex + 1 < target.length) {
    variants.push(target.slice(dotIndex + 1));
  }
  return variants;
}

function globMatchesAction(glob: string, tool: string, targets: readonly string[]): boolean {
  const matcher = globToRegExp(glob);
  if (matcher.test(tool)) {
    return true;
  }
  return targets.some((target) => matcher.test(`${tool}:${target}`) || matcher.test(target));
}

export function classifyTier(input: {
  tool: string;
  target: string;
  agentGlobs: readonly string[];
}): 1 | 2 | 3 {
  const variants = targetVariants(input.target);
  for (const glob of input.agentGlobs) {
    if (globMatchesAction(glob, input.tool, variants)) {
      return 3;
    }
  }
  return baselineTier(input.tool);
}

export function cooldownMsFor(tool: string, overrides: Record<string, number>): number {
  for (const [glob, ms] of Object.entries(overrides)) {
    if (globToRegExp(glob).test(tool)) return ms;
  }
  return 600_000;
}

export interface ActionGate {
  handleCall(req: {
    agent_id: string;
    tick_id: string;
    tool: string;
    args: unknown;
    _meta?: Record<string, unknown>;
    pending_action_id?: string;
  }): Promise<
    | { kind: "executed"; result: unknown; tier: 1 | 2 | 3; snapshot_id?: string }
    | { kind: "rejected"; error: string; details?: unknown }
    | { kind: "queued"; pending_action_id: string }
  >;
}

export interface ActionGateDeps {
  db: Database;
  executeTool: (tool: string, args: unknown, _meta?: Record<string, unknown>) => Promise<unknown>;
  takeSnapshot: (agent_id: string) => Promise<string>;
  now: () => number;
  log?: Pick<Logger, "warn">;
}

function parseJsonOr<T>(
  raw: string,
  fallback: T,
  log: Pick<Logger, "warn"> | undefined,
  context: Record<string, unknown>,
  label: string,
): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log?.warn({ ...context, err }, label);
    return fallback;
  }
}

const PARSE_FAILED: unique symbol = Symbol("parse_failed");
type ParseResult<T> = T | typeof PARSE_FAILED;

/**
 * Strict parse used for security-critical agent config (mcp_allowlist,
 * approval_required_globs). Returns a tagged failure on unparseable JSON so the
 * caller can fail closed (reject) instead of degrading to a permissive default.
 */
function parseJsonStrict<T>(
  raw: string,
  log: Pick<Logger, "warn"> | undefined,
  context: Record<string, unknown>,
  label: string,
): ParseResult<T> {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log?.warn({ ...context, err }, label);
    return PARSE_FAILED;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asStringRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function loadEffectiveMeta(
  deps: ActionGateDeps,
  req: ActionGateRequest,
): Record<string, unknown> | undefined {
  if (req._meta || !req.pending_action_id) {
    return req._meta;
  }
  const pendingMeta = deps.db
    .query<
      { meta_json: string | null },
      [string]
    >("SELECT meta_json FROM long_lived_pending_actions WHERE id = ?")
    .get(req.pending_action_id);
  if (!pendingMeta?.meta_json) {
    return undefined;
  }
  try {
    const parsedMeta = JSON.parse(pendingMeta.meta_json) as unknown;
    return asStringRecord(parsedMeta);
  } catch {
    return undefined;
  }
}

function loadAgentConfig(deps: ActionGateDeps, agentId: string): AgentGateConfig | null {
  return deps.db
    .query<
      AgentGateConfig,
      [string]
    >("SELECT mcp_allowlist_json, approval_required_globs_json, cooldown_overrides_json FROM long_lived_agents WHERE id=?")
    .get(agentId);
}

/**
 * Returns true when the tool matches the agent's mcp_allowlist. Returns
 * PARSE_FAILED when the allowlist JSON is unparseable so the caller can
 * fail closed; under the old fallback-to-[] behavior an unparseable
 * allowlist degraded to "no tools allowed" which was already restrictive,
 * but the analogous approval-globs path failed OPEN — both now reject.
 */
function isToolAllowed(
  agent: AgentGateConfig,
  req: ActionGateRequest,
  deps: ActionGateDeps,
): boolean | typeof PARSE_FAILED {
  const parsed = parseJsonStrict<unknown>(
    agent.mcp_allowlist_json,
    deps.log,
    { agent_id: req.agent_id, tick_id: req.tick_id, tool: req.tool, field: "mcp_allowlist_json" },
    "action-gate-invalid-agent-config",
  );
  if (parsed === PARSE_FAILED) return PARSE_FAILED;
  return (
    Array.isArray(parsed) &&
    parsed
      .filter((entry): entry is string => typeof entry === "string")
      .some((glob) => globToRegExp(glob).test(req.tool))
  );
}

function audit(
  deps: ActionGateDeps,
  input: {
    agentId: string;
    tickId: string;
    pendingActionId?: string;
    tool: string;
    target: string;
    decision: "gate_failed" | "queued" | "tool_failed" | "executed";
    reason: string;
  },
): void {
  deps.db
    .query(
      `INSERT INTO long_lived_action_audit
        (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agentId,
      input.tickId,
      input.pendingActionId ?? null,
      input.tool,
      input.target,
      input.decision,
      input.reason,
      deps.now(),
    );
}

/**
 * Returns the approval-required globs. Returns PARSE_FAILED when the JSON is
 * unparseable so the caller can fail closed (reject) — previously this
 * degraded to [] which downgraded tier-3 tools to tier-1 auto-execute.
 */
function approvalGlobs(
  deps: ActionGateDeps,
  agent: AgentGateConfig,
  req: ActionGateRequest,
): string[] | typeof PARSE_FAILED {
  const parsed = parseJsonStrict<unknown>(
    agent.approval_required_globs_json,
    deps.log,
    {
      agent_id: req.agent_id,
      tick_id: req.tick_id,
      tool: req.tool,
      field: "approval_required_globs_json",
    },
    "action-gate-invalid-agent-config",
  );
  if (parsed === PARSE_FAILED) return PARSE_FAILED;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function cooldownOverrides(
  deps: ActionGateDeps,
  agent: AgentGateConfig,
  req: ActionGateRequest,
): Record<string, number> {
  return parseJsonOr(
    agent.cooldown_overrides_json,
    {},
    deps.log,
    {
      agent_id: req.agent_id,
      tick_id: req.tick_id,
      tool: req.tool,
      field: "cooldown_overrides_json",
    },
    "action-gate-invalid-agent-config",
  );
}

function queueApproval(
  deps: ActionGateDeps,
  req: ActionGateRequest,
  target: string,
  effectiveMeta: Record<string, unknown> | undefined,
): ActionGateResult {
  const id = randomUUID();
  deps.db
    .query(
      `INSERT INTO long_lived_pending_actions
        (id, agent_id, tick_id, action_kind, action_target, payload_json, meta_json, status, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      req.agent_id,
      req.tick_id,
      req.tool,
      target,
      JSON.stringify(normalizeReplayArgs(req.args)),
      JSON.stringify(effectiveMeta ?? null),
      deps.now() + 7 * 24 * 60 * 60 * 1000,
      deps.now(),
    );
  audit(deps, {
    agentId: req.agent_id,
    tickId: req.tick_id,
    pendingActionId: id,
    tool: req.tool,
    target,
    decision: "queued",
    reason: "approval_required",
  });
  return { kind: "queued", pending_action_id: id };
}

function markPendingExecuted(deps: ActionGateDeps, tickId: string, pendingActionId?: string): void {
  if (!pendingActionId) {
    return;
  }
  deps.db
    .query("UPDATE long_lived_pending_actions SET executed_in_tick_id=? WHERE id=?")
    .run(tickId, pendingActionId);
}

function normalizeReplayArgs(args: unknown): unknown {
  return args === undefined ? {} : args;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => structurallyEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined)
    .sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]),
  );
}

function claimPendingReplay(deps: ActionGateDeps, req: ActionGateRequest): boolean {
  if (!req.pending_action_id) return false;
  const result = deps.db
    .query(
      `UPDATE long_lived_pending_actions
       SET executed_in_tick_id=?
       WHERE id=?
         AND agent_id=?
         AND status='approved'
         AND executed_in_tick_id IS NULL`,
    )
    .run(req.tick_id, req.pending_action_id, req.agent_id) as { changes: number };
  return result.changes === 1;
}

function clearPendingReplayClaim(deps: ActionGateDeps, req: ActionGateRequest): void {
  if (!req.pending_action_id) return;
  deps.db
    .query(
      `UPDATE long_lived_pending_actions
       SET executed_in_tick_id=NULL
       WHERE id=?
         AND agent_id=?
         AND executed_in_tick_id=?`,
    )
    .run(req.pending_action_id, req.agent_id, req.tick_id);
}

/**
 * Atomically checks the current cooldown and, if absent, reserves a new one
 * to the supplied until_at. Returns { reserved: true } when the caller now
 * owns the in-flight slot, or { reserved: false, cooldown_until } when a
 * concurrent caller already holds it. The check and write happen in one
 * synchronous db.transaction so two concurrent tier-2 calls cannot both
 * observe an absent cooldown and race past the gate.
 */
type CooldownReservation = { reserved: true } | { reserved: false; cooldown_until: number };

function reserveTier2Cooldown(
  deps: ActionGateDeps,
  agentId: string,
  tool: string,
  until: number,
): CooldownReservation {
  const now = deps.now();
  return deps.db.transaction((): CooldownReservation => {
    const existing = deps.db
      .query<
        { cooldown_until: number },
        [string, string]
      >("SELECT until_at AS cooldown_until FROM long_lived_cooldowns WHERE agent_id=? AND action_target=?")
      .get(agentId, tool);
    if (existing && existing.cooldown_until > now) {
      return { reserved: false, cooldown_until: existing.cooldown_until };
    }
    deps.db
      .query(
        `INSERT OR REPLACE INTO long_lived_cooldowns (agent_id, action_target, until_at, reason, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(agentId, tool, until, null, now);
    return { reserved: true };
  })();
}

/**
 * Clears a cooldown reservation in its own transaction. Used to roll back
 * the in-flight reservation when executeTool fails so the slot is not
 * burned by a failed attempt.
 */
function clearTier2Cooldown(deps: ActionGateDeps, agentId: string, tool: string): void {
  deps.db.transaction(() => {
    deps.db
      .query("DELETE FROM long_lived_cooldowns WHERE agent_id=? AND action_target=?")
      .run(agentId, tool);
  })();
}

async function executeTier2(
  deps: ActionGateDeps,
  agent: AgentGateConfig,
  req: ActionGateRequest,
  target: string,
  effectiveMeta: Record<string, unknown> | undefined,
  replayRequiresClaim: boolean,
): Promise<ActionGateResult> {
  if (replayRequiresClaim && !claimPendingReplay(deps, req)) {
    audit(deps, {
      agentId: req.agent_id,
      tickId: req.tick_id,
      pendingActionId: req.pending_action_id,
      tool: req.tool,
      target,
      decision: "gate_failed",
      reason: "already_executing",
    });
    return { kind: "rejected", error: "already_executing" };
  }

  const cdMs = cooldownMsFor(req.tool, cooldownOverrides(deps, agent, req));
  const until = deps.now() + cdMs;

  // Reserve the cooldown BEFORE running executeTool so two concurrent calls
  // cannot both pass the gate. On tool_failed we clear the reservation in a
  // second transaction so a failed attempt does not burn the slot.
  const reservation = reserveTier2Cooldown(deps, req.agent_id, req.tool, until);
  if (!reservation.reserved) {
    if (replayRequiresClaim) {
      clearPendingReplayClaim(deps, req);
    }
    audit(deps, {
      agentId: req.agent_id,
      tickId: req.tick_id,
      pendingActionId: req.pending_action_id,
      tool: req.tool,
      target,
      decision: "gate_failed",
      reason: "cooldown_active",
    });
    return {
      kind: "rejected",
      error: "cooldown_active",
      details: { expires: reservation.cooldown_until },
    };
  }

  let snapshotId: string;
  try {
    snapshotId = await deps.takeSnapshot(req.agent_id);
  } catch (err) {
    clearTier2Cooldown(deps, req.agent_id, req.tool);
    if (replayRequiresClaim) {
      clearPendingReplayClaim(deps, req);
    }
    audit(deps, {
      agentId: req.agent_id,
      tickId: req.tick_id,
      pendingActionId: req.pending_action_id,
      tool: req.tool,
      target,
      decision: "gate_failed",
      reason: `snapshot_failed: ${errorMessage(err)}`,
    });
    return { kind: "rejected", error: "snapshot_failed" };
  }

  const result = await executeToolOrAudit(deps, req, target, effectiveMeta);
  if (result.kind === "rejected") {
    clearTier2Cooldown(deps, req.agent_id, req.tool);
    if (replayRequiresClaim) {
      clearPendingReplayClaim(deps, req);
    }
    return result;
  }

  audit(deps, {
    agentId: req.agent_id,
    tickId: req.tick_id,
    pendingActionId: req.pending_action_id,
    tool: req.tool,
    target,
    decision: "executed",
    reason: snapshotId
      ? `snapshot:${snapshotId}; cooldown_until:${String(until)}`
      : `cooldown_until:${String(until)}`,
  });
  markPendingExecuted(deps, req.tick_id, req.pending_action_id);
  return { kind: "executed", result: result.result, tier: 2, snapshot_id: snapshotId };
}

async function executeToolOrAudit(
  deps: ActionGateDeps,
  req: ActionGateRequest,
  target: string,
  effectiveMeta: Record<string, unknown> | undefined,
): Promise<{ kind: "executed"; result: unknown } | { kind: "rejected"; error: "tool_failed" }> {
  try {
    return { kind: "executed", result: await deps.executeTool(req.tool, req.args, effectiveMeta) };
  } catch (err) {
    audit(deps, {
      agentId: req.agent_id,
      tickId: req.tick_id,
      pendingActionId: req.pending_action_id,
      tool: req.tool,
      target,
      decision: "tool_failed",
      reason: errorMessage(err),
    });
    return { kind: "rejected", error: "tool_failed" };
  }
}

async function executeTier1(
  deps: ActionGateDeps,
  req: ActionGateRequest,
  target: string,
  effectiveMeta: Record<string, unknown> | undefined,
  replayRequiresClaim: boolean,
): Promise<ActionGateResult> {
  if (replayRequiresClaim && !claimPendingReplay(deps, req)) {
    audit(deps, {
      agentId: req.agent_id,
      tickId: req.tick_id,
      pendingActionId: req.pending_action_id,
      tool: req.tool,
      target,
      decision: "gate_failed",
      reason: "already_executing",
    });
    return { kind: "rejected", error: "already_executing" };
  }

  const result = await executeToolOrAudit(deps, req, target, effectiveMeta);
  if (result.kind === "rejected") {
    if (replayRequiresClaim) {
      clearPendingReplayClaim(deps, req);
    }
    return result;
  }
  audit(deps, {
    agentId: req.agent_id,
    tickId: req.tick_id,
    pendingActionId: req.pending_action_id,
    tool: req.tool,
    target,
    decision: "executed",
    reason: "tier_1",
  });
  markPendingExecuted(deps, req.tick_id, req.pending_action_id);
  return { kind: "executed", result: result.result, tier: 1 };
}

/**
 * Returns true only when the supplied pending_action_id authorizes the
 * tier-3 → tier-1 downgrade for this request. The row must exist, belong to
 * the same agent, be in 'approved' status, and name the same tool and args.
 * Fail-closed: any other case rejects the downgrade so an unrelated or stale
 * pending_action_id cannot silently auto-execute a tier-3 tool. The atomic
 * claim step owns executed_in_tick_id checks so a matching replay that loses
 * the claim is rejected instead of re-queued.
 */
function pendingActionAuthorizesReplay(deps: ActionGateDeps, req: ActionGateRequest): boolean {
  if (!req.pending_action_id) return false;
  const row = deps.db
    .query<
      {
        agent_id: string;
        status: string;
        action_kind: string;
        payload_json: string;
      },
      [string]
    >(
      "SELECT agent_id, status, action_kind, payload_json FROM long_lived_pending_actions WHERE id = ?",
    )
    .get(req.pending_action_id);
  if (!row) return false;
  if (row.agent_id !== req.agent_id) return false;
  if (row.status !== "approved") return false;
  if (row.action_kind.toLowerCase() !== req.tool.toLowerCase()) return false;
  let approvedArgs: unknown;
  try {
    approvedArgs = JSON.parse(row.payload_json) as unknown;
  } catch {
    return false;
  }
  if (!structurallyEqual(normalizeReplayArgs(approvedArgs), normalizeReplayArgs(req.args))) {
    return false;
  }
  return true;
}

export function createActionGate(deps: ActionGateDeps): ActionGate {
  return {
    async handleCall(req): Promise<ActionGateResult> {
      const effectiveMeta = loadEffectiveMeta(deps, req);
      const agent = loadAgentConfig(deps, req.agent_id);
      if (!agent) return { kind: "rejected", error: "agent_not_found" };

      const target = extractActionTarget(req.tool, req.args);
      const allowed = isToolAllowed(agent, req, deps);
      if (allowed === PARSE_FAILED) {
        audit(deps, {
          agentId: req.agent_id,
          tickId: req.tick_id,
          pendingActionId: req.pending_action_id,
          tool: req.tool,
          target: "",
          decision: "gate_failed",
          reason: "agent_config_corrupt:mcp_allowlist",
        });
        return { kind: "rejected", error: "agent_config_corrupt" };
      }
      if (!allowed) {
        audit(deps, {
          agentId: req.agent_id,
          tickId: req.tick_id,
          pendingActionId: req.pending_action_id,
          tool: req.tool,
          target: "",
          decision: "gate_failed",
          reason: "not_in_allowlist",
        });
        return { kind: "rejected", error: "not_in_allowlist" };
      }

      const globs = approvalGlobs(deps, agent, req);
      if (globs === PARSE_FAILED) {
        audit(deps, {
          agentId: req.agent_id,
          tickId: req.tick_id,
          pendingActionId: req.pending_action_id,
          tool: req.tool,
          target,
          decision: "gate_failed",
          reason: "agent_config_corrupt:approval_required_globs",
        });
        return { kind: "rejected", error: "agent_config_corrupt" };
      }

      const baselineTier = classifyTier({ tool: req.tool, target, agentGlobs: [] });
      let tier = classifyTier({
        tool: req.tool,
        target,
        agentGlobs: globs,
      });
      // Fail-closed replay: only honor the tier-3 → tier-1 downgrade when the
      // supplied pending_action_id row exists, matches the agent, is approved,
      // and names the same tool and args. A stale or mismatched id falls
      // through to the normal tier-3 queue path.
      const replayAuthorized = req.pending_action_id
        ? pendingActionAuthorizesReplay(deps, req)
        : false;
      if (replayAuthorized) {
        tier = tier === 3 ? 1 : tier;
        if (baselineTier === 2) tier = 2;
      }

      if (tier === 3) {
        return queueApproval(deps, req, target, effectiveMeta);
      }

      if (tier === 2) {
        return await executeTier2(deps, agent, req, target, effectiveMeta, replayAuthorized);
      }

      return await executeTier1(deps, req, target, effectiveMeta, replayAuthorized);
    },
  };
}
