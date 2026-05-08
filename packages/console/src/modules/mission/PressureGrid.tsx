import { Card, CardHead } from "../../ui/Card";
import { PressureOrb } from "../../ui/PressureOrb";
import { usePressureSnapshot } from "../../hooks/usePressureSnapshot";

export function PressureGrid(): JSX.Element {
  const { windows } = usePressureSnapshot();

  return (
    <Card>
      <CardHead title="Pressure" />
      {windows.length === 0 ? (
        <div className="t-tertiary">No pressure data available.</div>
      ) : (
        <>
          <div
            className="orb-grid"
            style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}
          >
            {windows.slice(0, 4).map((w, i) => (
              <PressureOrb key={i} p={w} />
            ))}
          </div>
          {windows.length > 4 && (
            <details>
              <summary>{windows.length - 4} more</summary>
              <div
                className="orb-grid"
                style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}
              >
                {windows.slice(4).map((w, i) => (
                  <PressureOrb key={i + 4} p={w} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
