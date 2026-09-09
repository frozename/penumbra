import type {
  RegistrarDetail,
  RegistrarEntry,
  RegistrarEvent,
  RegistrarPhase,
} from "@penumbra/api-contract";

const BASE_TS = 1_756_200_000_000;

export function makeStoryEntry(overrides: Partial<RegistrarEntry> = {}): RegistrarEntry {
  return {
    registrar_id: "reg-story-1",
    slug: "plan-story",
    title: "Story initiative",
    home_project: "penumbra",
    source_doc_path: null,
    status: "active",
    created_at: BASE_TS,
    updated_at: BASE_TS + 3_600_000,
    rollup: { open_blockers: 0, open_follow_ups: 0 },
    phase_progress: { complete: 1, total: 3 },
    ...overrides,
  };
}

export function makeStoryPhases(
  registrarId: string,
  statuses: RegistrarPhase["status"][],
): RegistrarPhase[] {
  return statuses.map((status, index) => ({
    registrar_id: registrarId,
    phase_no: index + 1,
    title: `Phase ${String(index + 1)}`,
    status,
    updated_at: BASE_TS + index * 60_000,
  }));
}

export function makeStoryEvents(registrarId: string): RegistrarEvent[] {
  return [
    {
      event_id: 1,
      registrar_id: registrarId,
      phase_no: 1,
      kind: "progress",
      state: null,
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "maestro",
      body: "Kickoff complete; scope locked.",
      created_at: BASE_TS + 60_000,
    },
    {
      event_id: 2,
      registrar_id: registrarId,
      phase_no: 2,
      kind: "blocker",
      state: "opened",
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "worker",
      body: "Waiting on daemon migration review.",
      created_at: BASE_TS + 1_800_000,
    },
    {
      event_id: 3,
      registrar_id: registrarId,
      phase_no: 2,
      kind: "follow_up",
      state: "owed",
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "operator",
      body: "Document the kill-switch behavior.",
      created_at: BASE_TS + 3_000_000,
    },
  ];
}

export function makeStoryDetail(
  overrides: {
    entry?: Partial<RegistrarEntry>;
    phaseStatuses?: RegistrarPhase["status"][];
    events?: RegistrarEvent[];
    rollup?: RegistrarDetail["rollup"];
  } = {},
): RegistrarDetail {
  const entry = makeStoryEntry(overrides.entry);
  const phaseStatuses = overrides.phaseStatuses ?? ["complete", "active", "pending"];
  return {
    entry,
    phases: makeStoryPhases(entry.registrar_id, phaseStatuses),
    events: overrides.events ?? makeStoryEvents(entry.registrar_id),
    rollup: overrides.rollup ?? { open_blockers: 1, open_follow_ups: 1 },
  };
}
