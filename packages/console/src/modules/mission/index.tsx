import { StatRow } from "./StatRow";

export function MissionControl(): JSX.Element {
  return (
    <>
      <header className="surface-head">
        <h1>Mission Control</h1>
        <p className="lede">Live operator view of dispatches, handoffs, and pressure.</p>
      </header>
      <StatRow />
      {/* Subsequent panels (PendingHandoffs, PressureGrid, InFlightChains, T0Tail, RecentResolved)
          wire in here in 5.2-5.7. */}
    </>
  );
}
