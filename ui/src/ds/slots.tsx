import "./slots.css";

import { Meter } from "./meter";

export type SlotKind = "leased" | "ready" | "busy" | "broken" | "absent" | "free";

export interface Slot {
  readonly kind: SlotKind;
  readonly label: string;
}

// why: squares are drawn one per slot, so 100 slots would be 100 squares. A table cell, and any
// place that does not ask for squares, always shows the meter and the `n / m` fraction; a caller that
// asks for squares gets them only up to this many slots, and the meter above it.
const SLOT_SQUARES_MAX = 10;

// why: the group name carries the state counts even when the meter replaces individual tooltips.
export function Slots(props: {
  readonly slots: readonly Slot[];
  readonly label: string;
  readonly size?: "sm" | "md" | "lg";
  readonly squares?: boolean;
  // why: with squares, the `n / m` figure beside them; the meter always carries its own.
  readonly fraction?: boolean;
}) {
  const { fraction = false, label, size = "sm", slots, squares = false } = props;
  const leased = slots.filter((slot) => slot.kind === "leased").length;
  const figure = (
    <span className="slots-fraction mono">
      {leased} / {slots.length}
    </span>
  );
  if (!squares || slots.length > SLOT_SQUARES_MAX) {
    return (
      <span className="slots slots-meter" role="img" aria-label={label}>
        <Meter percent={slots.length === 0 ? 0 : (leased / slots.length) * 100} tone="neutral" />
        {figure}
      </span>
    );
  }
  return (
    <span className={`slots slots-${size}`} role="img" aria-label={label}>
      {slots.map((slot, index) => (
        <span key={index} className={`slot slot-${slot.kind}`} title={slot.label} />
      ))}
      {fraction ? figure : null}
    </span>
  );
}
