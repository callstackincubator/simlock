import { Link } from "../router";
import { VIEWS } from "./index";

/** A path the console has no view for, such as an old or mistyped link. */
export function NotFound() {
  const home = VIEWS[0];
  return (
    <section className="view">
      <h1>Page not found</h1>
      <p className="muted">The console has no page at this address.</p>
      {home === undefined ? null : (
        <p>
          <Link to={home.path}>Go to {home.label}</Link>
        </p>
      )}
    </section>
  );
}
