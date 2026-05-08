import { usePressureSnapshot } from "../hooks/usePressureSnapshot";

export function Titlebar(): JSX.Element {
  let peakUsedPct = 0;
  try {
    ({ peakUsedPct } = usePressureSnapshot());
  } catch {
    peakUsedPct = 0;
  }
  const pressureBand: "ok" | "warn" | "crit" =
    peakUsedPct >= 0.95 ? "crit" : peakUsedPct >= 0.8 ? "warn" : "ok";

  return (
    <header className="tb">
      <div className="tb-l">
        <div className="traffic" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand">
          <span className="penorb" />
          penumbra
          <span className="v">v0.8.2</span>
        </div>
      </div>
      <div className="tb-c" role="button" tabIndex={0}>
        <span className="dot dot-brand dot-live" style={{ width: 7, height: 7 }} />
        <span className="crumb">penumbra</span>
        <span className="crumb-sep">/</span>
        <span className="crumb" style={{ color: "var(--color-text)" }}>—</span>
        <span className="spacer" />
        <span className="t-ghost" style={{ fontSize: 10 }}>
          Cmd-K to jump
        </span>
        <span className="kbd">⌘K</span>
      </div>
      <div className="tb-r">
        <span
          className={`pressure-pip pressure-pip-${pressureBand}`}
          title={`Pressure ${Math.round(peakUsedPct * 100)}%`}
        >
          {Math.round(peakUsedPct * 100)}%
        </span>
        <button className="iconbtn" title="reload config">
          ↺
        </button>
        <button className="iconbtn" title="docs">
          ↗
        </button>
      </div>
    </header>
  );
}
