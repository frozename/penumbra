import { Card } from "./Card";
import { Sparkline, type SparklineProps } from "./Sparkline";

export interface StatCardProps extends Pick<SparklineProps, "seed"> {
  label: string;
  value: string | number;
  suffix?: string;
  delta: string;
  deltaCls?: string;
}

export function StatCard({
  label,
  value,
  suffix = "",
  delta,
  deltaCls = "",
  seed,
}: StatCardProps): JSX.Element {
  return (
    <Card className="stat">
      <div className="lab">{label}</div>
      <div className="val mono">
        {value}
        {suffix && <em>{suffix}</em>}
      </div>
      <div className={`d ${deltaCls}`.trim()}>{delta}</div>
      <Sparkline seed={seed} />
    </Card>
  );
}
