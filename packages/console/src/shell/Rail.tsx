import { useNavigate } from "react-router-dom";
import { useUIStore } from "../stores/ui-store";

export type RailModuleId = "mission" | "chains" | "tasks";

export interface RailProps {
  activeModule?: RailModuleId;
  onSelect?: (id: RailModuleId) => void;
}

const NAV: ReadonlyArray<{
  id: RailModuleId;
  label: string;
  icon: string;
  href: string;
}> = [
  { id: "mission", label: "Mission control", icon: "◐", href: "/mission" },
  { id: "chains", label: "Chains", icon: "≋", href: "/chains" },
  { id: "tasks", label: "Tasks", icon: "☷", href: "/tasks" },
];

function RailButtons({
  activeModule,
  onSelect,
}: {
  activeModule: RailModuleId;
  onSelect: (id: RailModuleId) => void;
}): JSX.Element {
  return (
    <nav className="rail">
      {NAV.map((n) => (
        <button
          key={n.id}
          className={"rail-btn " + (activeModule === n.id ? "active" : "")}
          onClick={() => onSelect(n.id)}
          title={n.label}
        >
          <span style={{ fontSize: 16, fontFamily: "var(--font-mono)" }}>
            {n.icon}
          </span>
          <span className="lbl">{n.label}</span>
        </button>
      ))}
      <div className="rail-spacer" />
      <button className="rail-btn" title="settings">
        ⚙
      </button>
    </nav>
  );
}

function RailWithNavigation({
  activeModule,
}: {
  activeModule: RailModuleId;
}): JSX.Element {
  const navigate = useNavigate();

  const handleSelect = (id: RailModuleId) => {
    const item = NAV.find((entry) => entry.id === id);
    if (!item) return;

    useUIStore.getState().setActiveModule(id);
    navigate(item.href);
  };

  return <RailButtons activeModule={activeModule} onSelect={handleSelect} />;
}

export function Rail(props: RailProps): JSX.Element {
  const activeModule = props.activeModule ?? useUIStore((s) => s.activeModule);

  if (props.onSelect) {
    return <RailButtons activeModule={activeModule} onSelect={props.onSelect} />;
  }

  return <RailWithNavigation activeModule={activeModule} />;
}
