import "./sidebar.css";

import { type ReactNode, useId, useState } from "react";

import { Icon, type IconName } from "./icon";
import { Link } from "./link";

export interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  readonly current: boolean;
  readonly count?: number;
  readonly alert?: boolean;
  readonly group?: string;
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
  readonly onSearch: () => void;
  readonly footer: (collapsed: boolean) => ReactNode;
}) {
  const { collapsed, entries, footer, onSearch, onToggle } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const groups = [...new Set(entries.flatMap((entry) => (entry.group ? [entry.group] : [])))];
  const nav = { collapsed, onNavigate: () => setMenuOpen(false) };
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
      <div className="sidebar-nav">
        <button
          type="button"
          className="sidebar-search"
          aria-label="Search or jump to…"
          title={collapsed ? "Search or jump to…" : undefined}
          onClick={() => {
            onSearch();
            setMenuOpen(false);
          }}
        >
          <Icon name="search" />
          <span className="nav-label">Search</span>
          <kbd aria-hidden="true" />
        </button>
        <NavList entries={entries.filter((entry) => entry.group === undefined)} {...nav} />
        {groups.map((group) => (
          <NavGroup
            key={group}
            label={group}
            entries={entries.filter((entry) => entry.group === group)}
            {...nav}
          />
        ))}
      </div>
      <div className="sidebar-foot">
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggle}
        >
          <Icon name={collapsed ? "expand" : "collapse"} />
        </button>
        {footer(collapsed)}
      </div>
    </nav>
  );
}

interface NavListProps {
  readonly entries: readonly NavEntry[];
  readonly collapsed: boolean;
  readonly onNavigate: () => void;
}

function NavList({ collapsed, entries, onNavigate }: NavListProps) {
  return (
    <ul className="sidebar-list">
      {entries.map((entry) => (
        <li key={entry.to}>
          <Link
            to={entry.to}
            className="nav-item"
            aria-current={entry.current ? "page" : undefined}
            title={collapsed ? entry.label : undefined}
            onClick={onNavigate}
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
  );
}

function NavGroup(props: NavListProps & { readonly label: string }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="nav-group">
      <p id={id} className="nav-group-label">
        {props.label}
      </p>
      <NavList {...props} />
    </div>
  );
}

export function Page(props: {
  readonly title: string;
  // why: a page one level down names its parent before its own title, as a link back.
  readonly crumb?: { readonly label: string; readonly to: string };
  // why: the state of what the page is about, drawn beside the title.
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const { actions, children, crumb, status, title } = props;
  const heading = (
    <h1 tabIndex={-1}>
      {crumb === undefined ? null : (
        <>
          <Link className="page-crumb" to={crumb.to}>
            {crumb.label}
          </Link>
          <span className="page-crumb">{" / "}</span>
        </>
      )}
      {title}
    </h1>
  );
  return (
    <div className="page">
      <header className="page-head">
        {status === undefined ? (
          heading
        ) : (
          <div className="page-title">
            <div className="page-title-row">
              {heading}
              {status}
            </div>
          </div>
        )}
        {actions === undefined ? null : <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
