import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient, Fetch } from "../data/api";
import type { Preferences } from "../data/preferences";
import type { Session } from "../data/session";
import { type Live, LiveContext } from "./live";
import { ConsoleProvider } from "./services";

// why: a screen rendered for a claim about its markup never talks to a daemon, so the services it
// reads are there to satisfy the context, and a call into any of them would be the finding.
export function inConsole(node: ReactNode): string {
  const services = {
    api: {} as unknown as ApiClient,
    confirm: () => Promise.resolve(),
    fetch: (() => Promise.reject(new Error("unused"))) as unknown as Fetch,
    notify: () => undefined,
    preferences: {} as unknown as Preferences,
    session: {} as unknown as Session,
  };
  const live = {
    mode: { mode: () => undefined, subscribe: () => () => undefined },
  } as unknown as Live;
  return renderToStaticMarkup(
    <ConsoleProvider {...services}>
      <LiveContext.Provider value={live}>{node}</LiveContext.Provider>
    </ConsoleProvider>,
  );
}
