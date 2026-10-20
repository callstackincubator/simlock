// why: every colour comes from the stylesheet, by class, so both themes apply and nothing sets a
// `<style>` element.
import "./chart.css";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

export interface MinuteCount {
  readonly at: number;
  readonly label: string;
  readonly count: number | null;
}

const HEIGHT = 240;
const MARGIN = { bottom: 0, left: 0, right: 8, top: 8 };

export function MinuteChart(props: {
  readonly kind: "area" | "columns";
  readonly title: string;
  readonly unit: string;
  readonly minutes: readonly MinuteCount[];
  readonly height?: number;
}) {
  const { height = HEIGHT, kind, minutes, title, unit } = props;
  const data = [...minutes];
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} minTickGap={24} interval="preserveStartEnd" />
      <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
      <Tooltip
        cursor={kind === "area" ? true : { className: "chart-cursor" }}
        isAnimationActive={false}
        filterNull={false}
        content={(content) => <MinuteTip content={content} unit={unit} />}
      />
    </>
  );
  return (
    <div className={`chart chart-${kind}`}>
      <ResponsiveContainer width="100%" height={height}>
        {kind === "area" ? (
          <AreaChart data={data} margin={MARGIN} title={title}>
            {axes}
            <Area
              dataKey="count"
              name={unit}
              type="monotone"
              isAnimationActive={false}
              className="chart-series"
              activeDot={{ className: "chart-dot", r: 4 }}
            />
          </AreaChart>
        ) : (
          <BarChart data={data} margin={MARGIN} title={title}>
            {axes}
            <Bar dataKey="count" name={unit} isAnimationActive={false} className="chart-series" />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function MinuteTip({
  content,
  unit,
}: {
  readonly content: TooltipContentProps<ValueType, NameType>;
  readonly unit: string;
}) {
  const { active, label, payload } = content;
  const value = payload[0]?.value;
  if (active !== true) return null;
  return (
    <div className="chart-tip">
      <span className="chart-tip-label">{label}</span>{" "}
      {value === null || value === undefined ? `${unit}: no data` : `${value} ${unit}`}
    </div>
  );
}

function columnOf(bucketMs: number): string {
  if (bucketMs >= 3_600_000) return "Hour";
  return bucketMs <= 60_000 ? "Minute" : "Time";
}

function disclosureOf(bucketMs: number): string {
  if (bucketMs >= 3_600_000) return "Hour by hour";
  if (bucketMs <= 60_000) return "Minute by minute";
  return `Every ${bucketMs / 60_000} minutes`;
}

export function MinuteTable(props: {
  readonly minutes: readonly MinuteCount[];
  readonly heading: string;
  readonly bucketMs?: number;
}) {
  const { bucketMs = 60_000, heading, minutes } = props;
  return (
    <details className="chart-data">
      <summary>{disclosureOf(bucketMs)}</summary>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{columnOf(bucketMs)}</th>
            <th scope="col" className="num">
              {heading}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...minutes].reverse().map((minute) => (
            <tr key={minute.at}>
              <td data-label={columnOf(bucketMs)} className="mono">
                {minute.label}
              </td>
              <td data-label={heading} className="num">
                {minute.count ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
