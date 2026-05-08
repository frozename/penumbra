import { PenumbraOrb } from "./PenumbraOrb";

export interface TitlebarProps {
  projectName?: string;
  viewName?: string;
  version?: string;
  onJump?: () => void;
  onReload?: () => void;
  onDocs?: () => void;
}

export function Titlebar({
  projectName = "penumbra",
  viewName = "—",
  version = "v0.8.2",
  onJump = () => {},
  onReload = () => {},
  onDocs = () => {},
}: TitlebarProps) {
  const handleJumpKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onJump();
    }
  };

  return (
    <header className="tb">
      <div className="tb-l">
        <div className="traffic" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand">
          <PenumbraOrb />
          penumbra
          <span className="v">{version}</span>
        </div>
      </div>
      <div
        className="tb-c"
        role="button"
        tabIndex={0}
        onClick={onJump}
        onKeyDown={handleJumpKeyDown}
      >
        <span className="dot dot-brand dot-live" style={{ width: 7, height: 7 }} />
        <span className="crumb">{projectName}</span>
        <span className="crumb-sep">/</span>
        <span className="crumb" style={{ color: "var(--color-text)" }}>
          {viewName}
        </span>
        <span className="spacer" />
        <span className="t-ghost" style={{ fontSize: 10 }}>
          Cmd-K to jump
        </span>
        <span className="kbd">⌘K</span>
      </div>
      <div className="tb-r">
        <button className="iconbtn" title="reload config" onClick={onReload}>
          ↺
        </button>
        <button className="iconbtn" title="docs" onClick={onDocs}>
          ↗
        </button>
      </div>
    </header>
  );
}
