import "./not-found.css";

import { ButtonLink, Card, Page } from "../ds";

export function NotFoundScreen() {
  return (
    <Page title="Page not found">
      <Card className="not-found">
        <p className="muted">The console has no page at this address.</p>
        <ButtonLink to="/">Go to the overview</ButtonLink>
      </Card>
    </Page>
  );
}
