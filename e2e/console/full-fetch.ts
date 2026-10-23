import type { Route } from "@playwright/test";

// why: the console sends back the ETag of its last answer, and `route.fetch()` forwards the console's
// headers, so a stub that edits the daemon's answer would be handed a 304 with no body to edit.
export function fetchFull(route: Route): ReturnType<Route["fetch"]> {
  const { "if-none-match": _tag, ...headers } = route.request().headers();
  return route.fetch({ headers });
}
