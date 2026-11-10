import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type SeatEvidence, SeatEvidenceSchema } from "./seat-profile.js";

export const DEFAULT_SEAT_PROFILE_EVIDENCE_PATH = "~/.penumbra/seat-profiles/evidence.jsonl";

export interface SeatProfileStoreOptions {
  path?: string;
}

export interface SeatProfileStoreAppendResult {
  appended: number;
  duplicates: number;
}

export interface SeatProfileStoreReadResult {
  evidence: SeatEvidence[];
  corrupt_lines: number;
}

export interface SeatProfileStore {
  append(evidence: SeatEvidence[]): Promise<SeatProfileStoreAppendResult>;
  read(): Promise<SeatProfileStoreReadResult>;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseEvidenceLine(line: string): SeatEvidence | null {
  try {
    const parsed: unknown = JSON.parse(line);
    const validated = SeatEvidenceSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

interface SeatProfileStoreFileState extends SeatProfileStoreReadResult {
  raw: string;
}

async function readFileState(path: string): Promise<SeatProfileStoreFileState> {
  try {
    const stats = await stat(path);
    if (stats.size === 0) {
      return { evidence: [], corrupt_lines: 0, raw: "" };
    }
    const raw = await readFile(path, "utf8");
    const evidence: SeatEvidence[] = [];
    let corrupt_lines = 0;

    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseEvidenceLine(line);
      if (record === null) {
        corrupt_lines += 1;
      } else {
        evidence.push(record);
      }
    }

    return { evidence, corrupt_lines, raw };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { evidence: [], corrupt_lines: 0, raw: "" };
    }
    throw error;
  }
}

function partitionAppends(
  evidence: SeatEvidence[],
  knownIds: Set<string>,
): { appendedRecords: SeatEvidence[]; duplicates: Set<string> } {
  const duplicates = new Set<string>();
  const appendedRecords: SeatEvidence[] = [];
  for (const record of evidence) {
    if (knownIds.has(record.evidence_id)) {
      duplicates.add(record.evidence_id);
    } else {
      knownIds.add(record.evidence_id);
      appendedRecords.push(record);
    }
  }
  return { appendedRecords, duplicates };
}

const appendQueues = new Map<string, Promise<void>>();

function serialAppend(
  path: string,
  evidence: SeatEvidence[],
): Promise<SeatProfileStoreAppendResult> {
  const prior = appendQueues.get(path) ?? Promise.resolve();
  const run = prior.then(() => executeAppend(path, evidence));
  appendQueues.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function createSeatProfileStore(opts: SeatProfileStoreOptions = {}): SeatProfileStore {
  const path = expandHome(opts.path ?? DEFAULT_SEAT_PROFILE_EVIDENCE_PATH);

  return {
    async read(): Promise<SeatProfileStoreReadResult> {
      const state = await readFileState(path);
      return { evidence: state.evidence, corrupt_lines: state.corrupt_lines };
    },
    append: (evidence) => serialAppend(path, evidence),
  };
}

async function executeAppend(
  path: string,
  evidence: SeatEvidence[],
): Promise<SeatProfileStoreAppendResult> {
  for (const record of evidence) {
    SeatEvidenceSchema.parse(record);
  }

  const state = await readFileState(path);
  const knownIds = new Set(state.evidence.map((e) => e.evidence_id));
  const { appendedRecords, duplicates } = partitionAppends(evidence, knownIds);

  if (appendedRecords.length === 0) {
    return { appended: 0, duplicates: duplicates.size };
  }

  await mkdir(dirname(path), { recursive: true });

  // O_APPEND writes are atomic per call, so concurrent appends from separate
  // processes or store instances cannot clobber each other's records the way
  // a read-modify-write + rename could.
  const needsNewline = state.raw !== "" && !state.raw.endsWith("\n");
  const chunk = `${needsNewline ? "\n" : ""}${appendedRecords.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await appendFile(path, chunk, "utf8");

  return { appended: appendedRecords.length, duplicates: duplicates.size };
}
