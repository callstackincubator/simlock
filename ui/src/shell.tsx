import { useEffect } from "react";

import { useSession } from "./console-context";
import { Link, navigate, usePath } from "./router";
import { VIEWS, viewFor } from "./views/index";
import { NotFound } from "./views/not-found";

/** The signed-in console: the header, the navigation from `VIEWS`, and the current view. */
export function Shell() {
  const session = useSession();
  const path = usePath();
  const view = viewFor(path);
  const home = VIEWS[0];

  useEffect(() => {
    if (path === "/" && home !== undefined) navigate(home.path, { replace: true });
  }, [path, home]);

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
        {view === undefined ? path === "/" ? null : <NotFound /> : <view.Component />}
      </main>
    </div>
  );
}
