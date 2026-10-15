import "./status.css";

import type { ReactNode } from "react";

// why: the colour is a second signal, never the only one, and never the accent.
export type Tone = "ok" | "warn" | "error" | "idle";

export function Status({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

// why: where a row has no room for the word, the square stands alone and carries the word as its
// accessible name and tooltip, so a screen reader and a pointer still read the state.
export function StatusDot({ tone, label }: { readonly tone: Tone; readonly label: string }) {
  return (
    <span className={`status-dot status-dot-${tone}`} role="img" aria-label={label} title={label} />
  );
}
