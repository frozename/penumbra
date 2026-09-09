import type { FixtureRouter } from "../router";
import { type HarnessState, type RegistrarEventRow, sendJson } from "../server";

export function nextRegistrarEventId(state: HarnessState): number {
  return state.registrarEvents.reduce((max, event) => Math.max(max, event.event_id), 0) + 1;
}

function registrarEventsFor(state: HarnessState, registrarId: string): RegistrarEventRow[] {
  return state.registrarEvents
    .filter((event) => event.registrar_id === registrarId)
    .sort((a, b) => a.created_at - b.created_at || a.event_id - b.event_id);
}

function registrarRollupFor(
  state: HarnessState,
  registrarId: string,
): { open_blockers: number; open_follow_ups: number } {
  const closed = new Set<string>();
  for (const event of state.registrarEvents) {
    if (event.registrar_id !== registrarId || event.ref_event_id === null) continue;
    if (event.state === "resolved" || event.state === "done" || event.state === "dropped") {
      closed.add(`${event.kind}:${String(event.ref_event_id)}`);
    }
  }
  let openBlockers = 0;
  let openFollowUps = 0;
  for (const event of state.registrarEvents) {
    if (event.registrar_id !== registrarId) continue;
    if (closed.has(`${event.kind}:${String(event.event_id)}`)) continue;
    if (event.kind === "blocker" && event.state === "opened") openBlockers += 1;
    if (event.kind === "follow_up" && event.state === "owed") openFollowUps += 1;
  }
  return { open_blockers: openBlockers, open_follow_ups: openFollowUps };
}

function registrarPhaseProgressFor(
  state: HarnessState,
  registrarId: string,
): { complete: number; total: number } {
  const phases = state.registrarPhases.filter((phase) => phase.registrar_id === registrarId);
  return {
    complete: phases.filter((phase) => phase.status === "complete").length,
    total: phases.length,
  };
}

export function register(router: FixtureRouter, state: HarnessState): void {
  router.route("GET", "/registrar", (ctx) => {
    sendJson(ctx.response, {
      entries: state.registrarEntries.map((entry) => ({
        ...entry,
        rollup: registrarRollupFor(state, entry.registrar_id),
        phase_progress: registrarPhaseProgressFor(state, entry.registrar_id),
      })),
    });
  });

  router.route("POST", "/registrar", (ctx) => {
    const body = ctx.body as
      | {
          title?: unknown;
          slug?: unknown;
          home_project?: unknown;
          phases?: unknown;
          source_doc_path?: unknown;
          status?: unknown;
        }
      | undefined;
    if (
      typeof body?.title !== "string" ||
      typeof body.slug !== "string" ||
      typeof body.home_project !== "string" ||
      !Array.isArray(body.phases) ||
      body.phases.some((phase) => typeof phase !== "string")
    ) {
      sendJson(ctx.response, { error: "invalid_input" }, 400);
      return;
    }
    const now = Date.now();
    state.registrarSeq += 1;
    const registrarId = `reg-${state.registrarSeq}`;
    state.registrarEntries.push({
      registrar_id: registrarId,
      slug: body.slug,
      title: body.title,
      home_project: body.home_project,
      source_doc_path: typeof body.source_doc_path === "string" ? body.source_doc_path : null,
      status:
        body.status === "draft" ||
        body.status === "active" ||
        body.status === "paused" ||
        body.status === "complete" ||
        body.status === "abandoned"
          ? body.status
          : "active",
      created_at: now,
      updated_at: now,
    });
    (body.phases as string[]).forEach((phaseTitle, index) => {
      state.registrarPhases.push({
        registrar_id: registrarId,
        phase_no: index + 1,
        title: phaseTitle,
        status: "pending",
        updated_at: now,
      });
    });
    sendJson(ctx.response, { registrar_id: registrarId }, 201);
  });

  router.route("GET", /^\/registrar\/(?<id>[^/]+)\/events$/, (ctx) => {
    const registrarId = decodeURIComponent(ctx.params.id ?? "");
    if (!state.registrarEntries.some((row) => row.registrar_id === registrarId)) {
      sendJson(ctx.response, { error: "registrar_not_found", registrar_id: registrarId }, 404);
      return;
    }
    sendJson(ctx.response, { events: registrarEventsFor(state, registrarId) });
  });

  router.route("POST", /^\/registrar\/(?<id>[^/]+)\/events$/, (ctx) => {
    const registrarId = decodeURIComponent(ctx.params.id ?? "");
    const entry = state.registrarEntries.find((row) => row.registrar_id === registrarId);
    if (!entry) {
      sendJson(ctx.response, { error: "registrar_not_found", registrar_id: registrarId }, 404);
      return;
    }
    const body = (ctx.body ?? {}) as Partial<Omit<RegistrarEventRow, "event_id" | "registrar_id">>;
    const event: RegistrarEventRow = {
      event_id: nextRegistrarEventId(state),
      registrar_id: registrarId,
      phase_no: typeof body.phase_no === "number" ? body.phase_no : null,
      kind: (body.kind ?? "progress") as RegistrarEventRow["kind"],
      state: typeof body.state === "string" ? body.state : null,
      ref_event_id: typeof body.ref_event_id === "number" ? body.ref_event_id : null,
      link_kind: typeof body.link_kind === "string" ? body.link_kind : null,
      link_value: typeof body.link_value === "string" ? body.link_value : null,
      actor: (body.actor ?? "operator") as RegistrarEventRow["actor"],
      body: typeof body.body === "string" ? body.body : "",
      created_at: typeof body.created_at === "number" ? body.created_at : Date.now(),
    };
    state.registrarEvents.push(event);
    entry.updated_at = event.created_at;
    sendJson(ctx.response, { event });
  });

  router.route("GET", /^\/registrar\/(?<id>[^/]+)$/, (ctx) => {
    const registrarId = decodeURIComponent(ctx.params.id ?? "");
    const entry = state.registrarEntries.find((row) => row.registrar_id === registrarId);
    if (!entry) {
      sendJson(ctx.response, { error: "registrar_not_found", registrar_id: registrarId }, 404);
      return;
    }
    sendJson(ctx.response, {
      entry,
      phases: state.registrarPhases
        .filter((phase) => phase.registrar_id === registrarId)
        .sort((a, b) => a.phase_no - b.phase_no),
      events: registrarEventsFor(state, registrarId),
      rollup: registrarRollupFor(state, registrarId),
    });
  });
}
