import { useNavigate } from "react-router-dom";

import { useApprovalsCount } from "../modules/approvals/hooks";
import { type ModuleId, MODULES, type ModuleSpec } from "../modules/manifest";
import { useUIStore } from "../stores/ui-store";

export type RailModuleId = ModuleId;

export interface RailProps {
  activeModule?: RailModuleId;
  onSelect?: (id: string) => void;
  modules?: readonly ModuleSpec[];
}

function RailButtons({
  activeModule,
  onSelect,
  pendingCount,
  modules,
}: {
  activeModule: RailModuleId;
  onSelect: (id: string) => void;
  pendingCount: number;
  modules: readonly ModuleSpec[];
}): JSX.Element {
  return (
    <nav className="rail">
      {modules
        .filter((m) => m.available)
        .map((n) => (
          <button
            key={n.id}
            className={"rail-btn " + (activeModule === n.id ? "active" : "")}
            onClick={() => {
              onSelect(n.id);
            }}
            title={n.label}
          >
            <span style={{ fontSize: 16, fontFamily: "var(--font-mono)" }}>{n.icon}</span>
            <span className="lbl">{n.label}</span>
            {n.id === "approvals" && pendingCount > 0 && (
              <span className="pip warn">{pendingCount}</span>
            )}
          </button>
        ))}
      <div className="rail-spacer" />
    </nav>
  );
}

function RailWithNavigation({
  activeModule,
  pendingCount,
  modules,
}: {
  activeModule: RailModuleId;
  pendingCount: number;
  modules: readonly ModuleSpec[];
}): JSX.Element {
  const navigate = useNavigate();

  const handleSelect = (id: string): void => {
    const item = MODULES.find((entry) => entry.id === id);
    if (!item) return;

    useUIStore.getState().setActiveModule(item.id);
    navigate(item.path);
  };

  return (
    <RailButtons
      activeModule={activeModule}
      onSelect={handleSelect}
      pendingCount={pendingCount}
      modules={modules}
    />
  );
}

export function Rail(props: RailProps): JSX.Element {
  const activeModule = props.activeModule ?? useUIStore((s) => s.activeModule);
  const pendingCount = useApprovalsCount();
  const modules = props.modules ?? MODULES;

  if (props.onSelect) {
    return (
      <RailButtons
        activeModule={activeModule}
        onSelect={props.onSelect}
        pendingCount={pendingCount}
        modules={modules}
      />
    );
  }

  return (
    <RailWithNavigation activeModule={activeModule} pendingCount={pendingCount} modules={modules} />
  );
}
