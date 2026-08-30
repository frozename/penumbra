export class RegistrarSlugTaken extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`registrar slug '${slug}' is already taken`);
    this.name = "RegistrarSlugTaken";
    this.slug = slug;
  }
}

export class RegistrarNotFound extends Error {
  readonly registrar_id: string;

  constructor(registrar_id: string) {
    super(`registrar ${registrar_id} not found`);
    this.name = "RegistrarNotFound";
    this.registrar_id = registrar_id;
  }
}

export class PhaseNotFound extends Error {
  readonly registrar_id: string;
  readonly phase_no: number;

  constructor(registrar_id: string, phase_no: number) {
    super(`registrar phase ${registrar_id}/${String(phase_no)} not found`);
    this.name = "PhaseNotFound";
    this.registrar_id = registrar_id;
    this.phase_no = phase_no;
  }
}

export class InvalidPhaseTransition extends Error {
  readonly registrar_id: string;
  readonly phase_no: number;
  readonly from_status: string;

  constructor(registrar_id: string, phase_no: number, from_status: string) {
    super(`registrar phase ${registrar_id}/${String(phase_no)} is no longer '${from_status}'`);
    this.name = "InvalidPhaseTransition";
    this.registrar_id = registrar_id;
    this.phase_no = phase_no;
    this.from_status = from_status;
  }
}

export class InvalidEntryTransition extends Error {
  readonly registrar_id: string;
  readonly from_status: string;
  readonly current_status: string;

  constructor(registrar_id: string, from_status: string, current_status: string) {
    super(`registrar entry ${registrar_id} is no longer '${from_status}'`);
    this.name = "InvalidEntryTransition";
    this.registrar_id = registrar_id;
    this.from_status = from_status;
    this.current_status = current_status;
  }
}

export class UnknownJournalRef extends Error {
  readonly registrar_id: string;
  readonly ref_event_id: number;

  constructor(registrar_id: string, ref_event_id: number) {
    super(`registrar ${registrar_id} has no journal event ${String(ref_event_id)}`);
    this.name = "UnknownJournalRef";
    this.registrar_id = registrar_id;
    this.ref_event_id = ref_event_id;
  }
}
