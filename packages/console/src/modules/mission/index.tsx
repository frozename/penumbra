import { StatRow } from "./StatRow";
import { PendingHandoffs } from "./PendingHandoffs";
import { PressureGrid } from "./PressureGrid";
import { InFlightChains } from "./InFlightChains";
import { T0Tail } from "./T0Tail";
import { RecentResolved } from "./RecentResolved";

export function MissionControl(): JSX.Element {
  return (
    <>
      <header className="surface-head">
        <h1>Mission Control</h1>
        <p className="lede">Live operator view of dispatches, handoffs, and pressure.</p>
      </header>
      <StatRow />
      <div
        className="mc-row"
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 16,
          marginTop: 16,
        }}
      >
        <PendingHandoffs />
        <PressureGrid />
      </div>
      <div style={{ marginTop: 16 }}>
        <InFlightChains />
      </div>
      <div
        className="mc-row"
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 16,
          marginTop: 16,
        }}
      >
        <T0Tail />
        <RecentResolved />
      </div>
    </>
  );
}
