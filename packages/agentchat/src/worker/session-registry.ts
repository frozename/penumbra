export interface InjectableSessionLike {
  adapter?: string | null;
  inject?: (message: { role: "user"; text: string }) => Promise<void> | void;
}

const sessions = new Map<string, InjectableSessionLike>();

export function registerSession(handoffId: string, session: InjectableSessionLike): void {
  sessions.set(handoffId, session);
}

export function unregisterSession(handoffId: string): void {
  sessions.delete(handoffId);
}

export function lookupSession(handoffId: string): InjectableSessionLike | null {
  return sessions.get(handoffId) ?? null;
}
