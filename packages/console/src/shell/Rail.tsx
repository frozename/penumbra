import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MODULES, type ModuleId } from "../modules/manifest";
import { useUIStore } from "../stores/ui-store";
import { DaemonClient } from "../api/client";
import { useDaemonStore } from "../stores/daemon-store";

export type RailModuleId = ModuleId;

export interface RailProps {
  activeModule?: RailModuleId;
  onSelect?: (id: RailModuleId) => void;
}

function usePendingHandoffsCount(intervalMs = 5_000): number {
  const client = useMemo(
    () => new DaemonClient({ getConfig: () => useDaemonStore.getState() }),
    [],
  );
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const res = await client.listHandoffs({ status: "pending" });
        if (!mounted) return;
        setCount(res.handoffs?.length ?? 0);
      } catch {
        if (!mounted) return;
        setCount(0);
      }
    };
    void poll();
    const timer = globalThis.setInterval(() => {
      void poll();
    }, intervalMs);
    return () => {
      mounted = false;
      globalThis.clearInterval(timer);
    };
  }, [client, intervalMs]);

  return count;
}

function RailButtons({
  activeModule,
  onSelect,
  pendingCount,
}: {
  activeModule: RailModuleId;
  onSelect: (id: RailModuleId) => void;
  pendingCount: number;
}): JSX.Element {
  return (
    <nav className="rail">
      {MODULES.map((n) => (
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
          {n.id === "mission" && pendingCount > 0 && (
            <span className="pip warn">{pendingCount}</span>
          )}
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
  pendingCount,
}: {
  activeModule: RailModuleId;
  pendingCount: number;
}): JSX.Element {
  const navigate = useNavigate();

  const handleSelect = (id: RailModuleId) => {
    const item = MODULES.find((entry) => entry.id === id);
    if (!item) return;

    useUIStore.getState().setActiveModule(id);
    navigate(item.path);
  };

  return (
    <RailButtons
      activeModule={activeModule}
      onSelect={handleSelect}
      pendingCount={pendingCount}
    />
  );
}

export function Rail(props: RailProps): JSX.Element {
  const activeModule = props.activeModule ?? useUIStore((s) => s.activeModule);
  const pendingCount = usePendingHandoffsCount();

  if (props.onSelect) {
    return (
      <RailButtons
        activeModule={activeModule}
        onSelect={props.onSelect}
        pendingCount={pendingCount}
      />
    );
  }

  return (
    <RailWithNavigation activeModule={activeModule} pendingCount={pendingCount} />
  );
}
