import { join } from "node:path";

import type {
  Clock,
  DaemonHealth,
  DaemonPort,
  DispatchedHandoff,
  Exec,
  FsPort,
  Http,
  InFlight,
  LogCursor,
  LogReader,
  LogSource,
} from "./types.js";

const HTTP_TIMEOUT_MS = 3_000;

async function readPort(fs: FsPort, storageRoot: string): Promise<number | null> {
  const raw = await fs.readText(join(storageRoot, "port"));
  const port = Number((raw ?? "").trim());
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

interface HandoffListBody {
  handoffs?: { handoff_id?: unknown; to_agent?: unknown; worker_id?: unknown; status?: unknown }[];
}

function toDispatched(row: NonNullable<HandoffListBody["handoffs"]>[number]): DispatchedHandoff {
  return {
    handoffId: typeof row.handoff_id === "string" ? row.handoff_id : "?",
    agent: typeof row.to_agent === "string" ? row.to_agent : "?",
    workerId: typeof row.worker_id === "string" ? row.worker_id : null,
  };
}

function parseInFlight(text: string): InFlight {
  let body: HandoffListBody;
  try {
    body = JSON.parse(text) as HandoffListBody;
  } catch {
    return { ok: false, error: "daemon returned invalid JSON for /handoffs" };
  }
  if (!Array.isArray(body.handoffs)) {
    return { ok: false, error: "daemon /handoffs response has no handoffs array" };
  }
  const dispatched = body.handoffs.filter((row) => row.status === "dispatched").map(toDispatched);
  const approved = body.handoffs.filter((row) => row.status === "approved").length;
  return { ok: true, dispatched, approved };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Talks to the running daemon over loopback HTTP (port and token from the storage root). */
export function createDaemonPort(storageRoot: string, fs: FsPort, http: Http): DaemonPort {
  return {
    health: async (): Promise<DaemonHealth> => {
      const port = await readPort(fs, storageRoot);
      if (port === null) return { ok: false, port, detail: `no valid port in ${storageRoot}/port` };
      try {
        const res = await http(`http://127.0.0.1:${String(port)}/health`, {
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        const ok = res.status === 200 && /"status"\s*:\s*"ok"/.test(res.text);
        return { ok, port, detail: ok ? "ok" : `GET /health returned HTTP ${String(res.status)}` };
      } catch (err) {
        return { ok: false, port, detail: `GET /health failed: ${describeError(err)}` };
      }
    },
    inFlight: async (): Promise<InFlight> => {
      const port = await readPort(fs, storageRoot);
      const token = (await fs.readText(join(storageRoot, "token")))?.trim() ?? "";
      if (port === null || token === "") {
        return { ok: false, error: `daemon port/token not found under ${storageRoot}` };
      }
      try {
        const res = await http(
          `http://127.0.0.1:${String(port)}/handoffs?status=dispatched,approved`,
          { headers: { authorization: `Bearer ${token}` }, timeoutMs: HTTP_TIMEOUT_MS },
        );
        if (res.status !== 200) {
          return { ok: false, error: `GET /handoffs returned HTTP ${String(res.status)}` };
        }
        return parseInFlight(res.text);
      } catch (err) {
        return { ok: false, error: `GET /handoffs failed: ${describeError(err)}` };
      }
    },
  };
}

/** Reads service logs written after a cursor: a byte offset for files, a timestamp for the journal. */
export function createLogReader(fs: FsPort, exec: Exec, clock: Clock): LogReader {
  return {
    cursor: async (source: LogSource): Promise<LogCursor> => {
      if (source.kind === "file") {
        return { kind: "offset", value: (await fs.size(source.path)) ?? 0 };
      }
      return { kind: "since", value: clock.now() };
    },
    readSince: async (source: LogSource, cursor: LogCursor): Promise<string> => {
      if (source.kind === "file") {
        const size = (await fs.size(source.path)) ?? 0;
        const offset = cursor.kind === "offset" && cursor.value <= size ? cursor.value : 0;
        return await fs.readFrom(source.path, offset);
      }
      if (source.kind === "journal") {
        const sinceS = Math.floor((cursor.kind === "since" ? cursor.value : 0) / 1000);
        const res = await exec(
          [
            "journalctl",
            "--user",
            "--unit",
            source.unit,
            "--since",
            `@${String(sinceS)}`,
            "--output",
            "cat",
            "--no-pager",
          ],
          { timeoutMs: 30_000 },
        );
        return res.code === 0 ? res.stdout : "";
      }
      return "";
    },
  };
}
