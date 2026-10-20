import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/app";
import { createApiClient, type Fetch } from "./data/api";
import { createPreferences } from "./data/preferences";
import { createSession } from "./data/session";

const fetch: Fetch = (input, init) => window.fetch(input, init);
const session = createSession(() => window.sessionStorage, {
  fetch,
  now: () => Date.now(),
  reload: () => window.location.reload(),
});
const preferences = createPreferences(() => window.localStorage);
const api = createApiClient({ fetch, onRefused: session.refused, token: session.token });

session.start();

const root = document.getElementById("root");
if (root === null) throw new Error("The console page has no #root element");
createRoot(root).render(
  <StrictMode>
    <App api={api} fetch={fetch} preferences={preferences} session={session} />
  </StrictMode>,
);
