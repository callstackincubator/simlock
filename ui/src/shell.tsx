import { useEffect } from "react";

import { useApi, useSession } from "./console-context";
import { ConnectionBanner } from "./live/connection-banner";
import { Link, navigate, usePath } from "./router";
import { VIEWS, viewFor } from "./views/index";
import { NotFound } from "./views/not-found";

/** The signed-in console: the header, the navigation from `VIEWS`, and the current view. */
export function Shell() {
  const api = useApi();
  const session = useSession();
  const path = usePath();
  const view = viewFor(path);

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
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Simlock
        </span>
        <button className="button button-quiet" type="button" onClick={() => session.signOut()}>
          Sign out
        </button>
      </header>
      <ConnectionBanner />
      <nav className="nav" aria-label="Console">
        <ul>
          {VIEWS.map((entry) => (
            <li key={entry.path}>
              <Link to={entry.path} aria-current={entry === view ? "page" : undefined}>
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        {view === undefined ? <NotFound /> : <view.Component />}
      </main>
    </div>
  );
}
