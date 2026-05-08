export interface PressureWindowSnapshot {
  used_pct: number;
  refuse_pct: number;
  warn_pct: number;
  provider: string;
  model: string;
  window_label: string;
}

export interface PressureOrbProps {
  p: PressureWindowSnapshot;
}

export function providerLabel(p: string): string {
  return (
    (
      {
        anthropic: "Anthropic",
        openai: "OpenAI",
        google: "Google",
        "opencode-go": "OpenCode-Go",
      } as Record<string, string>
    )[p] ?? p
  );
}

const DIM = 44;
const R = 18;
const CX = DIM / 2;
const CY = DIM / 2;
const C = 2 * Math.PI * R;

export function PressureOrb({ p }: PressureOrbProps): JSX.Element {
  const used = p.used_pct;
  const refuse = p.refuse_pct;
  const warn = p.warn_pct;
  const state = used >= refuse ? "crit" : used >= warn ? "warn" : "ok";
  const color =
    state === "crit"
      ? "var(--color-err)"
      : state === "warn"
        ? "var(--color-warn)"
        : "var(--color-brand)";
  const offset = C * (1 - used);

  return (
    <div className={`orb ${state}`}>
      <svg className="orb-svg" viewBox={`0 0 ${DIM} ${DIM}`}>
        <circle
          cx={CX}
          cy={CY}
          r={R}
          stroke="var(--color-surface-3)"
          strokeWidth="3"
          fill="none"
        />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          stroke="var(--color-warn)"
          strokeOpacity="0.4"
          strokeWidth="2"
          strokeDasharray={`${C * 0.005} ${C * 0.995}`}
          strokeDashoffset={C * (1 - warn) - C * 0.0025}
          fill="none"
          transform={`rotate(-90 ${CX} ${CY})`}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          stroke="var(--color-err)"
          strokeOpacity="0.5"
          strokeWidth="2"
          strokeDasharray={`${C * 0.005} ${C * 0.995}`}
          strokeDashoffset={C * (1 - refuse) - C * 0.0025}
          fill="none"
          transform={`rotate(-90 ${CX} ${CY})`}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={C}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${CX} ${CY})`}
        />
        <text
          x={CX}
          y={CY + 3}
          textAnchor="middle"
          fontSize="9"
          fontFamily="var(--font-mono)"
          fontWeight="600"
          fill={color}
        >
          {Math.round(used * 100)}
        </text>
      </svg>
      <div className="orb-meta">
        <div className="prov">{providerLabel(p.provider)}</div>
        <div className="mod">{p.model}</div>
        <div className="t-tertiary mono" style={{ fontSize: 10 }}>
          {p.window_label} · warn {Math.round(warn * 100)} · cap{" "}
          {Math.round(refuse * 100)}
        </div>
      </div>
    </div>
  );
}
