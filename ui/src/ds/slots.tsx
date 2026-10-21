import "./slots.css";

import type { CSSProperties } from "react";

export type SlotKind = "leased" | "ready" | "busy" | "broken" | "absent" | "free";

export interface Slot {
  readonly kind: SlotKind;
  readonly label: string;
}

// why: every slot carries its word as a tooltip and in the group's text, so the colours are never
// the only way to read a worker's devices.
export function Slots(props: {
  readonly slots: readonly Slot[];
  readonly label: string;
  readonly size?: "sm" | "lg";
}) {
  const { label, size = "sm", slots } = props;
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

export function SlotLegend() {
  return (
    <ul className="slot-legend" aria-hidden="true">
      {LEGEND.map((entry) => (
        <li key={entry.kind}>
          <span className={`slot slot-${entry.kind}`} />
          {entry.word}
        </li>
      ))}
    </ul>
  );
}

export type ShareKind = SlotKind | "drained" | "shutdown" | "offline";

export interface Share {
  readonly kind: ShareKind;
  readonly percent: number;
}

// why: the bar repeats figures printed beside it, so it is hidden from a screen reader; each share's
// width arrives as a custom property, which the CSP allows where a style attribute is not.
export function ShareBar({ shares }: { readonly shares: readonly Share[] }) {
  return (
    <span className="share-bar" aria-hidden="true">
      {shares.map((share) => (
        <span
          key={share.kind}
          className={`share slot-${share.kind}`}
          style={{ "--share": `${Math.max(0, Math.min(100, share.percent))}%` } as CSSProperties}
        />
      ))}
    </span>
  );
}
