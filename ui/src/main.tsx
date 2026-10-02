import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createApiClient, type Fetch } from "./api";
import { App } from "./app";
import { createSession } from "./session";

function sessionStorageOrNone(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

const fetch: Fetch = (input, init) => window.fetch(input, init);
const session = createSession(sessionStorageOrNone());
const api = createApiClient({ fetch, signOut: session.signOut, token: session.token });

const root = document.getElementById("root");
if (root === null) throw new Error("The console page has no #root element");
createRoot(root).render(
  <StrictMode>
    <App api={api} fetch={fetch} session={session} />
  </StrictMode>,
);
