import "./meter.css";

import type { CSSProperties } from "react";

import type { Tone } from "./status";

// why: a meter only shades a figure printed beside it, so it has no accessible name of its own;
// the level arrives as a custom property, which the CSP allows where a style attribute is not.
export function Meter(props: {
  readonly percent: number;
  readonly tone: Tone | "neutral";
  readonly size?: "thin" | "regular";
}) {
  const { percent, size = "regular", tone } = props;
  const level = `${Math.max(0, Math.min(100, percent))}%`;
  return (
    <span
      className={`load-bar load-bar-${tone} meter-${size}`}
      aria-hidden="true"
      style={{ "--load-bar": level } as CSSProperties}
    >
      <span className="load-bar-fill" />
    </span>
  );
}
