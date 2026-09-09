import type { FixtureRouter } from "../router";
import { type HarnessState, sendJson } from "../server";

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", "/session-events", (ctx) => {
    let events = state.sessionEvents.slice();
    const sessionId = ctx.query.get("session_id");
    const kindPrefix = ctx.query.get("kind_prefix");
    const since = ctx.query.get("since");
    const limitRaw = ctx.query.get("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    if (sessionId) events = events.filter((event) => event.session_id === sessionId);
    if (kindPrefix) events = events.filter((event) => event.kind.startsWith(kindPrefix));
    if (since) events = events.filter((event) => Date.parse(event.ts) >= Date.parse(since));
    events.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    sendJson(ctx.response, { events: limit && limit > 0 ? events.slice(0, limit) : events });
  });

  router.route("GET", "/session-notes/drafts", (ctx) => {
    const status = ctx.query.get("status");
    const limitRaw = ctx.query.get("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const drafts = status
      ? state.sessionNoteDrafts.filter((draft) => draft.status === status)
      : state.sessionNoteDrafts.slice();
    sendJson(ctx.response, { drafts: limit && limit > 0 ? drafts.slice(0, limit) : drafts });
  });

  router.route("POST", "/session-notes/approve", (ctx) => {
    const body = (ctx.body ?? {}) as { draft_id?: string };
    const draft = state.sessionNoteDrafts.find((d) => d.draft_id === body.draft_id);
    if (!draft) {
      sendJson(ctx.response, { error: "not_found" }, 404);
      return;
    }
    draft.status = "approved";
    draft.reviewed_at = new Date().toISOString();
    sendJson(ctx.response, { draft, event: null });
  });
}
