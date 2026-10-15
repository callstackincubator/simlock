import { Link, Page } from "../ds";

export function NotFoundScreen() {
  return (
    <Page title="Page not found">
      <p className="muted">The console has no page at this address.</p>
      <p>
        <Link to="/">Go to the overview</Link>
      </p>
    </Page>
  );
}
