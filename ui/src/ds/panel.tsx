import "./panel.css";

import { type ReactNode, useId } from "react";

// why: a panel is a region named by its title, so a screen reader can jump straight to it.
export function Panel(props: {
  readonly title: string;
  readonly actions?: ReactNode;
  // why: a figure that sits right after the title, as "now 19" does beside a chart's name.
  readonly lead?: ReactNode;
  readonly flush?: boolean;
  readonly level?: 1 | 2;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { actions, children, className, flush = false, lead, level = 2, title } = props;
  const Heading = level === 1 ? "h1" : "h2";
  const id = useId();
  const classes = ["panel", flush ? "panel-flush" : undefined, className].filter(Boolean).join(" ");
  return (
    <section className={classes} aria-labelledby={id}>
      <header className="panel-header">
        <Heading
          id={id}
          className={lead === undefined ? "panel-title" : "panel-title panel-title-lead"}
        >
          {title}
        </Heading>
        {lead}
        {actions === undefined ? null : <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Card(props: { readonly className?: string; readonly children: ReactNode }) {
  const { children, className } = props;
  return <div className={className === undefined ? "card" : `card ${className}`}>{children}</div>;
}

export function Grid(props: {
  readonly min?: "sm" | "md" | "lg";
  readonly children: ReactNode;
  readonly label?: string;
}) {
  const { children, label, min = "md" } = props;
  return (
    <div
      className={`grid grid-${min}`}
      role={label === undefined ? undefined : "group"}
      aria-label={label}
    >
      {children}
    </div>
  );
}

// why: the main panel takes two shares and its neighbour one, and they stack on a phone; a row
// laid out here keeps every page's proportions the same.
export function Row(props: { readonly children: ReactNode; readonly even?: boolean }) {
  return <div className={props.even === true ? "row row-even" : "row"}>{props.children}</div>;
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Id({ children }: { readonly children: string }) {
  return (
    <span className="id" title={children}>
      {children}
    </span>
  );
}
