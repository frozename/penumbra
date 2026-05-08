import { useDaemonStore } from "../stores/daemon-store";

export interface StatusbarProps {
  port?: number;
  branch?: string;
  dispatched?: number;
  resolved?: number;
  t0Count?: number;
  theme?: string;
  tz?: string;
  version?: string;
}

function resolvePort(port?: number): string {
  if (port !== undefined) return String(port);
  const baseUrl = useDaemonStore.getState().baseUrl;
  try {
    const parsed = new URL(baseUrl);
    return parsed.port || "?";
  } catch {
    return "?";
  }
}

function resolveTz(tz?: string): string {
  if (tz) return tz;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function Statusbar(props: StatusbarProps): JSX.Element {
  const health = useDaemonStore((s) => s.health);
  const port = resolvePort(props.port);
  const branch = props.branch ?? "—";
  const dispatched = props.dispatched ?? 0;
  const resolved = props.resolved ?? 0;
  const t0Count = props.t0Count ?? 0;
  const theme = props.theme ?? "sirius";
  const tz = resolveTz(props.tz);
  const version = props.version ?? "v0.8.2";
  const dotClass =
    health === "ok"
      ? "dot dot-ok"
      : health === "down"
        ? "dot dot-err"
        : "dot dot-warn";

  return (
    <footer className="sb">
      <div className="g">
        <div className="it">
          <span className={dotClass} />
          daemon · 127.0.0.1:{port}
        </div>
        <div className="it">⎇ {branch}</div>
        <div className="it">
          {dispatched} dispatched · {resolved} resolved
        </div>
        <div className="it">{t0Count} t0 in tail</div>
      </div>
      <div className="g">
        <div className="it">{theme}</div>
        <div className="it">{tz}</div>
        <div className="it brand">penumbra · {version}</div>
      </div>
    </footer>
  );
}
