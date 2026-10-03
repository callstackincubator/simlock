import { useSyncExternalStore } from "react";

import type { ApiClient, Fetch } from "./api";
import { ConsoleProvider } from "./console-context";
import { LiveProvider } from "./live/live-context";
import type { Session } from "./session";
import { Shell } from "./shell";
import { SignIn } from "./sign-in";

/**
 * Signed out, the sign-in screen; signed in, the shell and its live data. A sign-out anywhere
 * comes straight back here, which unmounts the live data and closes its stream.
 */
export function App(props: {
  readonly api: ApiClient;
  readonly fetch: Fetch;
  readonly session: Session;
}) {
  const { api, fetch, session } = props;
  const token = useSyncExternalStore(session.subscribe, session.token);
  return (
    <ConsoleProvider api={api} session={session}>
      {token === undefined ? (
        <SignIn fetch={fetch} />
      ) : (
        <LiveProvider>
          <Shell />
        </LiveProvider>
      )}
    </ConsoleProvider>
  );
}
