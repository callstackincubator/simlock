/**
 * The pieces every view is laid out with (docs/internal/DESIGN.md): a page header, a row of stat
 * cards, and panels, each a card with a header over a table, a chart or a list.
 */
import { type ReactNode, useId } from "react";

/** The wordmark in its orange block, and who makes it. The sign-in screen has it too. */
export function Brand() {
  return (
    <span className="brand">
      <span className="wordmark">Simlock</span>
      <span className="chip">By Callstack</span>
    </span>
  );
}

/** A view's title, a one-line muted subtitle under it, and its actions on the right. */
export function PageHeader(props: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  /** Set the title in mono, for a title that is an id. */
  readonly mono?: boolean;
}) {
  const { actions, mono = false, subtitle, title } = props;
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1 className={mono ? "mono" : undefined}>{title}</h1>
        {subtitle === undefined ? null : <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** One stat card: a label, a big number, and a caption saying what the number counts. */
export interface Stat {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
}

/** A row of stat cards. Each card's label, number and caption are read in that order. */
export function StatCards({ stats }: { readonly stats: readonly Stat[] }) {
  return (
    <ul className="stats" aria-label="Summary">
      {stats.map((stat) => (
        <li key={stat.label} className="stat">
          <p className="stat-label">{stat.label}</p>
          <p className="stat-value">{stat.value}</p>
          <p className="stat-caption">{stat.caption}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * A card with a header: a title, a description under it, and actions on the right. The panel
 * is a region named by its title, so a screen reader can jump to it.
 */
export function Panel(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { actions, children, className, description, title } = props;
  const id = useId();
  return (
    <section
      className={className === undefined ? "panel" : `panel ${className}`}
      aria-labelledby={id}
    >
      <div className="panel-header">
        <div>
          <h2 id={id} className="panel-title">
            {title}
          </h2>
          {description === undefined ? null : <p className="panel-description">{description}</p>}
        </div>
        {actions === undefined ? null : <div className="panel-actions">{actions}</div>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * A long id (a lease's, a worker's, a device's) on one line, cut with an ellipsis where it does
 * not fit. The whole id is in its `title`, and in the text a screen reader and a copy read.
 */
export function Id({ children }: { readonly children: string }) {
  return (
    <span className="id" title={children}>
      {children}
    </span>
  );
}
