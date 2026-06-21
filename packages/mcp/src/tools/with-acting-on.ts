export type ActingOnKind =
  | "handoff"
  | "conversation"
  | "task"
  | "plan"
  | "long_lived_agent"
  | "long_lived_tick"
  | "permission"
  | "worktree"
  | "maestro_session";

export const DEFAULT_ID_KIND_MAP: Record<string, ActingOnKind> = {
  handoff_id: "handoff",
  conversation_id: "conversation",
  task_id: "task",
  plan_id: "plan",
  long_lived_agent_id: "long_lived_agent",
  long_lived_tick_id: "long_lived_tick",
  permission_id: "permission",
  worktree_id: "worktree",
};

export type ActingOn = { kind: ActingOnKind; id: string };

export type Handler<I = unknown, O = unknown> = (input: I) => Promise<O> | O;

export function withActingOnEnvelope<I, O>(
  handler: Handler<I, O>,
  idKindMap: Record<string, ActingOnKind> = DEFAULT_ID_KIND_MAP,
): (input: I) => Promise<O | (O & { acting_on: ActingOn })> {
  return async (input: I) => {
    const result = await handler(input);
    const actingOn = extractActingOn(input, idKindMap);
    if (!actingOn) return result;
    if (!isPlainObject(result)) return result;
    if ("acting_on" in (result as Record<string, unknown>)) return result;
    return { acting_on: actingOn, ...(result as Record<string, unknown>) } as O & {
      acting_on: ActingOn;
    };
  };
}

function extractActingOn(input: unknown, map: Record<string, ActingOnKind>): ActingOn | null {
  if (!isPlainObject(input)) return null;
  for (const [field, kind] of Object.entries(map)) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) {
      return { kind, id: value };
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
