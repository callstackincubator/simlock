/**
 * The console's charts, drawn with Recharts in the style docs/internal/DESIGN.md describes: an
 * orange line or columns, a faint orange fill, light grid lines, mono axis labels. Every colour
 * comes from the stylesheet, by class, so both themes apply and nothing sets a `<style>`
 * element (ADR 0011 §4). Nothing moves: animation is off.
 *
 * A chart is never the only place its numbers are: `MinuteTable` lists every minute as text.
 */
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

import type { MinuteCount } from "./views/history-model";

const HEIGHT = 240;
const MARGIN = { bottom: 0, left: 0, right: 8, top: 8 };

/**
 * A chart of a count per minute: an area for a level held over time, columns for how many
 * things happened in each minute. `title` names it to a screen reader, which can also step
 * through its minutes with the arrow keys once the chart has focus.
 */
export function MinuteChart(props: {
  readonly kind: "area" | "columns";
  readonly title: string;
  /** What one minute's count is, such as "leases held": the tooltip's label. */
  readonly unit: string;
  readonly minutes: readonly MinuteCount[];
}) {
  const { kind, minutes, title, unit } = props;
  const data = [...minutes];
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} minTickGap={24} interval="preserveStartEnd" />
      <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
      <Tooltip
        cursor={kind === "area" ? true : { className: "chart-cursor" }}
        isAnimationActive={false}
        content={(content) => <MinuteTip content={content} unit={unit} />}
      />
    </>
  );
  return (
    <div className={`chart chart-${kind}`}>
      <ResponsiveContainer width="100%" height={HEIGHT}>
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
  if (active !== true || value === undefined) return null;
  return (
    <div className="chart-tip">
      <span className="chart-tip-label">{label}</span> {value} {unit}
    </div>
  );
}

/** Every minute of a chart and its count, as text, behind a disclosure under the chart. */
export function MinuteTable(props: {
  readonly minutes: readonly MinuteCount[];
  /** The count column's heading, such as "Leases held". */
  readonly heading: string;
}) {
  const { heading, minutes } = props;
  return (
    <details className="chart-data">
      <summary>Minute by minute</summary>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Minute</th>
            <th scope="col" className="num">
              {heading}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...minutes].reverse().map((minute) => (
            <tr key={minute.at}>
              <td data-label="Minute" className="mono">
                {minute.label}
              </td>
              <td data-label={heading} className="num">
                {minute.count}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
