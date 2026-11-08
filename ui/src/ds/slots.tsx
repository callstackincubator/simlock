import "./slots.css";

import { Meter } from "./meter";

export type SlotKind = "leased" | "ready" | "busy" | "broken" | "absent" | "free";

export interface Slot {
  readonly kind: SlotKind;
  readonly label: string;
}

// why: the group name carries the state counts even when the meter replaces individual tooltips.
export function Slots(props: {
  readonly slots: readonly Slot[];
  readonly label: string;
  readonly size?: "sm" | "md" | "lg";
}) {
  const { label, size = "sm", slots } = props;
  if (slots.length > 10) {
    const leased = slots.filter((slot) => slot.kind === "leased").length;
    return (
      <span className="slots slots-meter" role="img" aria-label={label}>
        <Meter percent={(leased / slots.length) * 100} tone="neutral" />
        <span>
          {leased} / {slots.length}
        </span>
      </span>
    );
  }
  return (
    <span className={`slots slots-${size}`} role="img" aria-label={label}>
      {slots.map((slot, index) => (
        <span key={index} className={`slot slot-${slot.kind}`} title={slot.label} />
      ))}
    </span>
  );
}

const LEGEND: readonly { readonly kind: SlotKind; readonly word: string }[] = [
  { kind: "leased", word: "leased" },
  { kind: "ready", word: "ready" },
  { kind: "busy", word: "booting" },
  { kind: "broken", word: "quarantined" },
  { kind: "free", word: "free" },
];

export function SlotLegend({ kinds }: { readonly kinds?: readonly SlotKind[] }) {
  return (
    <ul className="slot-legend" aria-hidden="true">
      {LEGEND.filter((entry) => kinds === undefined || kinds.includes(entry.kind)).map((entry) => (
        <li key={entry.kind}>
          <span className={`slot slot-${entry.kind}`} />
          {entry.word}
        </li>
      ))}
    </ul>
  );
}
