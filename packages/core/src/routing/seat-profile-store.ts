import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

let writeSeq = 0;

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

export function createSeatProfileStore(opts: SeatProfileStoreOptions = {}): SeatProfileStore {
  const path = expandHome(opts.path ?? DEFAULT_SEAT_PROFILE_EVIDENCE_PATH);

  return {
    async read(): Promise<SeatProfileStoreReadResult> {
      const state = await readFileState(path);
      return { evidence: state.evidence, corrupt_lines: state.corrupt_lines };
    },
    async append(evidence: SeatEvidence[]): Promise<SeatProfileStoreAppendResult> {
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

      let existingRaw = state.raw;
      if (existingRaw !== "" && !existingRaw.endsWith("\n")) {
        existingRaw += "\n";
      }

      const newLines = `${appendedRecords.map((r) => JSON.stringify(r)).join("\n")}\n`;
      const tmpPath = `${path}.tmp-${String(process.pid)}-${String(++writeSeq)}`;

      try {
        await writeFile(tmpPath, `${existingRaw}${newLines}`, "utf8");
        await rename(tmpPath, path);
      } catch (error) {
        await rm(tmpPath, { force: true });
        throw error;
      }

      return { appended: appendedRecords.length, duplicates: duplicates.size };
    },
  };
}
