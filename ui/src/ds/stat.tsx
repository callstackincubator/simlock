import "./stat.css";

import type { ReactNode } from "react";

import { Link } from "./link";

export interface StatTileProps {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly to?: string;
  readonly children?: ReactNode;
}

// why: a tile that leads somewhere is a link as a whole, so the number itself is the target and
// a screen reader hears label, value and unit as one name.
export function StatTile(props: StatTileProps) {
  const { children, label, to, unit, value } = props;
  const body = (
    <>
      <span className="stat-label">{label}</span>{" "}
      <span className="stat-line">
        <span className="stat-value">{value}</span>
        {unit === undefined ? null : (
          <>
            {" "}
            <span className="stat-unit">{unit}</span>
          </>
        )}
      </span>
      {children}
    </>
  );
  return (
    <li className="stat">
      {to === undefined ? (
        <div className="stat-body">{body}</div>
      ) : (
        <Link className="stat-body stat-link" to={to}>
          {body}
        </Link>
      )}
    </li>
  );
}

export function StatRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <ul className="stats" aria-label={label}>
      {children}
    </ul>
  );
}
