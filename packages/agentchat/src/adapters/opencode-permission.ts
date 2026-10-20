import type {
  AcpPermissionReply,
  AcpPermissionReplyKind,
  AcpPermissionResponse,
} from "./acp-types.js";

export interface PermissionAskWireProps {
  id?: unknown;
  sessionID?: unknown;
  permission?: unknown;
  action?: unknown;
  patterns?: unknown;
  resources?: unknown;
}

export interface PermissionAsk {
  requestID: string;
  sessionID: string;
  permission: string;
  patterns: string[];
}

export interface PermissionAskOutcome {
  permission: string;
  reply: AcpPermissionReplyKind;
  replyFailed: boolean;
}

export function readAskPatterns(
  wireType: string,
  props: PermissionAskWireProps | undefined,
): string[] {
  const raw = wireType === "permission.v2.asked" ? props?.resources : props?.patterns;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string");
}

// `permission.asked` carries the v1 shape {id, sessionID, permission, ...};
// `permission.v2.asked` carries {id, sessionID, action, ...}. Normalizing here
// lets one policy answer both — an ask that reads cleanly but cannot be tied
// to a request id is unanswerable and must not wedge the stream loop.
export function readPermissionAsk(
  wireType: string,
  props: PermissionAskWireProps | undefined,
  fallbackSessionId: string,
): PermissionAsk | null {
  const rawId = props?.id;
  const rawKind = wireType === "permission.v2.asked" ? props?.action : props?.permission;
  const rawSession = props?.sessionID;
  if (typeof rawId !== "string" || rawId.length === 0) return null;
  if (typeof rawKind !== "string" || rawKind.length === 0) return null;
  return {
    requestID: rawId,
    sessionID:
      typeof rawSession === "string" && rawSession.length > 0 ? rawSession : fallbackSessionId,
    permission: rawKind,
    patterns: readAskPatterns(wireType, props),
  };
}

// dispatch_events.meta_json is capped at 4096 bytes; over that the stored meta
// is flattened to {_truncated, kind, original_size} and loses the permission
// outcome/route fields. Bound the asked patterns well under the cap and flag
// the drop so an oversized ask stays legible in the incident trail.
const PERMISSION_PATTERNS_META_BUDGET = 2048;
const PERMISSION_PATTERN_MAX_CHARS = 512;

export function capAskPatterns(patterns: readonly string[]): {
  list: string[];
  truncated: boolean;
} {
  const kept: string[] = [];
  let jsonSize = 2;
  let truncated = false;
  for (const raw of patterns) {
    const entry =
      raw.length > PERMISSION_PATTERN_MAX_CHARS
        ? `${raw.slice(0, PERMISSION_PATTERN_MAX_CHARS)}…`
        : raw;
    if (entry !== raw) truncated = true;
    const entrySize = JSON.stringify(entry).length + (kept.length > 0 ? 1 : 0);
    if (jsonSize + entrySize > PERMISSION_PATTERNS_META_BUDGET) {
      truncated = true;
      break;
    }
    kept.push(entry);
    jsonSize += entrySize;
  }
  return { list: kept, truncated };
}

export type AskReplyRoute = "reply" | "respond" | "v2";

export interface PermissionReplyClient {
  replyPermission(requestID: string, reply: AcpPermissionReply): Promise<void>;
  respondPermission(
    sessionID: string,
    permissionID: string,
    response: AcpPermissionResponse,
  ): Promise<void>;
  replySessionPermission(
    sessionID: string,
    requestID: string,
    reply: AcpPermissionReply,
  ): Promise<void>;
}

// v1 asks go to the request-keyed reply route first (it carries a rejection
// message back to the model) and fall back to the deprecated session-scoped
// respond route, which is the documented pairing for `permission.asked` and
// stays mounted on builds where the experimental reply route is absent. The
// returned route is the LAST route attempted so a failure event says which
// route rejected.
export async function sendAskReply(args: {
  client: PermissionReplyClient;
  wireType: string;
  ask: PermissionAsk;
  reply: AcpPermissionReplyKind;
  approved: boolean;
}): Promise<{ route: AskReplyRoute; error?: unknown }> {
  const { client, wireType, ask, reply, approved } = args;
  const rejection = approved
    ? {}
    : { message: `penumbra: permission '${ask.permission}' auto-rejected` };
  if (wireType === "permission.v2.asked") {
    try {
      await client.replySessionPermission(ask.sessionID, ask.requestID, { reply, ...rejection });
      return { route: "v2" };
    } catch (err) {
      return { route: "v2", error: err };
    }
  }
  try {
    await client.replyPermission(ask.requestID, { reply, ...rejection });
    return { route: "reply" };
  } catch {
    try {
      await client.respondPermission(ask.sessionID, ask.requestID, { response: reply });
      return { route: "respond" };
    } catch (err) {
      return { route: "respond", error: err };
    }
  }
}

// opencode halts the turn on a plain permission reject (unless
// experimental.continue_loop_on_deny is set): the persona goes idle with no
// text and the dispatch would otherwise be recorded as an empty success. A
// reply_failed reject counts too — the reply never reached opencode, but our
// side still rejected the ask and the idle-empty shape is identical to the
// cascade it triggers when the reply does land.
export function throwOnRejectedAskIdleEmpty(
  rejectedAsks: readonly { permission: string; replyFailed: boolean }[],
  text: string,
): void {
  if (rejectedAsks.length === 0 || text.trim().length > 0) return;
  const replyFailed = rejectedAsks.filter((ask) => ask.replyFailed).length;
  const kinds = rejectedAsks.map((ask) => ask.permission).join(",");
  throw new Error(
    `opencode-acp: turn ended idle with empty text after ${String(rejectedAsks.length)} rejected permission ask(s) [${kinds}] (${String(replyFailed)} reply_failed); opencode halts the turn on a plain permission reject`,
  );
}
