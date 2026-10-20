import "./sidebar.css";

import { type ReactNode, useState } from "react";

import { Icon, type IconName } from "./icon";
import { Link } from "./link";

export interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  readonly current: boolean;
  readonly count?: number;
  readonly alert?: boolean;
}

export function Wordmark({ short = false }: { readonly short?: boolean }) {
  return (
    <span className={short ? "wordmark wordmark-short" : "wordmark"}>
      {short ? (
        <>
          <span aria-hidden="true">S</span>
          <span className="visually-hidden">Simlock</span>
        </>
      ) : (
        "Simlock"
      )}
    </span>
  );
}

export function AppFrame(props: { readonly sidebar: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {props.sidebar}
      <main id="main" className="app-main" tabIndex={-1}>
        {props.children}
      </main>
    </div>
  );
}

// why: on a phone the sidebar folds into a bar with a menu button; `collapsed` is the operator's
// own choice on a wide screen, kept by the app, and changing pages never changes it.
export function Sidebar(props: {
  readonly entries: readonly NavEntry[];
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly footer: (collapsed: boolean) => ReactNode;
}) {
  const { collapsed, entries, footer, onToggle } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <nav
      className={`sidebar${collapsed ? " sidebar-collapsed" : ""}${menuOpen ? " sidebar-open" : ""}`}
      aria-label="Console"
    >
      <div className="sidebar-top">
        <span className="sidebar-mark-full">
          <Wordmark />
        </span>
        <span className="sidebar-mark-short">
          <Wordmark short />
        </span>
        <button
          type="button"
          className="sidebar-menu"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name={menuOpen ? "close" : "menu"} />
        </button>
      </div>
      <ul className="sidebar-nav">
        {entries.map((entry) => (
          <li key={entry.to}>
            <Link
              to={entry.to}
              className="nav-item"
              aria-current={entry.current ? "page" : undefined}
              title={collapsed ? entry.label : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <Icon name={entry.icon} />
              <span className="nav-label">{entry.label}</span>
              {entry.count === undefined || entry.count === 0 ? null : (
                <span className={entry.alert === true ? "nav-count nav-count-alert" : "nav-count"}>
                  {entry.count}
                  <span className="visually-hidden">{entry.count === 1 ? " item" : " items"}</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        {footer(collapsed)}
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggle}
        >
          <Icon name={collapsed ? "expand" : "collapse"} />
          <span className="nav-label">Collapse</span>
        </button>
      </div>
    </nav>
  );
}

export function Page(props: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const { actions, children, title } = props;
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
        {actions === undefined ? null : <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
