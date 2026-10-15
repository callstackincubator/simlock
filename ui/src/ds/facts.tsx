import "./facts.css";

import type { ReactNode } from "react";

export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
}

// why: `raw` keeps keys as the daemon spelled them (`leaseId`), where the label capitals would
// make a camelCase name unreadable.
export function Facts(props: { readonly facts: readonly Fact[]; readonly raw?: boolean }) {
  const { facts, raw = false } = props;
  return (
    <dl className={raw ? "facts facts-raw" : "facts"}>
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
