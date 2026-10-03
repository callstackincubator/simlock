import { useEffect } from "react";

import { useApi, useSession } from "./console-context";
import { Brand } from "./layout";
import { ConnectionBanner } from "./live/connection-banner";
import { Link, navigate, usePath } from "./router";
import { useAttentionCount } from "./views/attention";
import { VIEWS, type View, viewFor } from "./views/index";
import { NotFound } from "./views/not-found";

/** The signed-in console: the header, the tab bar from `VIEWS`, and the current view. */
export function Shell() {
  const api = useApi();
  const session = useSession();
  const path = usePath();
  const view = viewFor(path);
  const attention = useAttentionCount();

  // ADR 0011 §6: a 401 at any time signs the operator out. A tab reloaded with a token that has
  // since been revoked finds out here, before any view asks for data.
  useEffect(() => {
    api.getJson("/v1/workers").catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (path === "/" && view !== undefined) navigate(view.path, { replace: true });
  }, [path, view]);

  useEffect(() => {
    document.title = view === undefined ? "Simlock" : `${view.label} · Simlock`;
  }, [view]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Brand />
        <div className="topbar-end">
          <ConnectionBanner />
          <button
            className="button button-secondary"
            type="button"
            onClick={() => session.signOut()}
          >
            Sign out
          </button>
        </div>
      </header>
      <TabBar views={VIEWS} current={view} counts={{ "/attention": attention }} />
      <main id="main" className="main" tabIndex={-1}>
        {view === undefined ? <NotFound /> : <view.Component />}
      </main>
    </div>
  );
}

/**
 * One tab per view, in the order of `views`. The current one is marked for the eye with an
 * underline and for a screen reader with `aria-current`. A view with a count above zero in
 * `counts` shows it on its tab; at zero, or with none, the tab shows no number.
 */
export function TabBar(props: {
  readonly views: readonly View[];
  readonly current: View | undefined;
  readonly counts: Readonly<Partial<Record<View["path"], number | undefined>>>;
}) {
  const { counts, current, views } = props;
  return (
    <nav className="tabs" aria-label="Console">
      <ul>
        {views.map((entry) => {
          const count = counts[entry.path];
          return (
            <li key={entry.path}>
              <Link to={entry.path} aria-current={entry === current ? "page" : undefined}>
                {entry.label}
                {count === undefined || count === 0 ? null : (
                  <>
                    {" "}
                    <span className="nav-count">
                      {count}
                      <span className="visually-hidden">{count === 1 ? " item" : " items"}</span>
                    </span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
