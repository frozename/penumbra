export function Explorer(): JSX.Element {
  const projectName = "penumbra";
  const projectId =
    "/Volumes/WorkSSD/repos/penumbra-worktrees/9adf5379-d159-4904-9d65-0a59e87a67fa";
  const branch = "main";
  const dirty = 0;

  // TODO: wire from daemon /workspace endpoint when it exists.
  return (
    <aside className="exp">
      <div className="exp-proj">
        <div className="t-label" style={{ marginBottom: 6 }}>
          PROJECT
        </div>
        <div className="exp-proj-card">
          <span className="pdot" />
          <div className="ptxt">
            <div className="pname">{projectName}</div>
            <div className="ppath">{projectId}</div>
          </div>
          <span className="pchev">▾</span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginTop: 6,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span className="mono t-tertiary" style={{ fontSize: 10 }}>
            ⎇ {branch}
          </span>
          {dirty > 0 ? (
            <span className="mono" style={{ fontSize: 10, color: "var(--color-warn)" }}>
              {dirty} dirty
            </span>
          ) : (
            <span className="mono t-ghost" style={{ fontSize: 10 }}>
              clean
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
