import "./master-detail.css";

import { type ReactNode, useId } from "react";

import { Link } from "./link";

// why: below 768px there is room for one pane, so the page shows the list until something is
// chosen and the inspector after; `focus` says which, from the URL, so back returns to the list.
export function MasterDetail(props: {
  readonly focus: "list" | "detail";
  readonly list: ReactNode;
  readonly detail: ReactNode;
  readonly wide?: boolean;
}) {
  const { detail, focus, list, wide = false } = props;
  return (
    <div className={`master-detail focus-${focus}${wide ? " master-wide" : ""}`}>
      {list}
      {detail}
    </div>
  );
}

export function ListPane(props: {
  readonly title: string;
  readonly meta?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const { children, footer, meta, title, toolbar } = props;
  const id = useId();
  return (
    <section className="list-pane" aria-labelledby={id}>
      <header className="list-head">
        <div className="list-title">
          <h1 id={id}>{title}</h1>
          {meta === undefined ? null : <span className="list-meta">{meta}</span>}
        </div>
        {toolbar}
      </header>
      <div className="list-body">{children}</div>
      {footer === undefined ? null : <div className="list-foot">{footer}</div>}
    </section>
  );
}

export function List({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <ul className="list" aria-label={label}>
      {children}
    </ul>
  );
}

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

export interface Crumb {
  readonly label: string;
  readonly to?: string;
}

export function Inspector(props: {
  readonly crumbs: readonly Crumb[];
  readonly title: ReactNode;
  readonly mono?: boolean;
  readonly line?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const { actions, children, crumbs, line, mono = false, title } = props;
  const id = useId();
  return (
    <section className="inspector" aria-labelledby={id}>
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="crumb">
            {crumb.to === undefined ? crumb.label : <Link to={crumb.to}>{crumb.label}</Link>}
          </span>
        ))}
      </nav>
      <header className="inspector-head">
        <div className="inspector-heading">
          <h2 id={id} className={mono ? "inspector-title mono" : "inspector-title"}>
            {title}
          </h2>
          {line === undefined ? null : <p className="inspector-line">{line}</p>}
        </div>
        {actions === undefined ? null : <div className="inspector-actions">{actions}</div>}
      </header>
      <div className="inspector-body">{children}</div>
    </section>
  );
}

export function InspectorEmpty({ children }: { readonly children: ReactNode }) {
  return (
    <section className="inspector inspector-empty">
      <p className="muted">{children}</p>
    </section>
  );
}
