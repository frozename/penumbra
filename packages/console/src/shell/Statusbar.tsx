import { useDaemonStore } from "../stores/daemon-store";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function resolvePort(): string {
  const baseUrl = useDaemonStore.getState().baseUrl;
  try {
    const parsed = new URL(baseUrl);
    return parsed.port || "?";
  } catch {
    return "?";
  }
}

export function Statusbar(): JSX.Element {
  const health = useDaemonStore((s) => s.health);
  const port = resolvePort();
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
        <div className="it">⎇ —</div>
        <div className="it">0 dispatched · 0 resolved</div>
        <div className="it">0 t0 in tail</div>
      </div>
      <div className="g">
        <div className="it">sirius</div>
        <div className="it">{tz}</div>
        <div className="it brand">penumbra · v0.8.2</div>
      </div>
    </footer>
  );
}
