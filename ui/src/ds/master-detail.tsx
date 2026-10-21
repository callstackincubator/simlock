import "./master-detail.css";

import type { ReactNode } from "react";

import { Link } from "./link";

export interface ListRowProps {
  readonly to: string;
  readonly selected: boolean;
  readonly title: ReactNode;
  readonly lead?: ReactNode;
  readonly aside?: ReactNode;
  readonly sub?: ReactNode;
  readonly trail?: ReactNode;
  readonly mono?: boolean;
}

export function ListRow(props: ListRowProps) {
  const { aside, lead, mono = false, selected, sub, title, to, trail } = props;
  return (
    <li className="list-item">
      <Link to={to} className="list-row" aria-current={selected ? "page" : undefined}>
        <span className="list-lead">{lead}</span>
        <span className={mono ? "list-row-title mono" : "list-row-title"}>{title}</span>
        <span className="list-aside">{aside}</span>
        {sub === undefined && trail === undefined ? null : (
          <>
            <span />
            <span className="list-sub">{sub}</span>
            <span className="list-trail">{trail}</span>
          </>
        )}
      </Link>
    </li>
  );
}
