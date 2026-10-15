import { useSyncExternalStore } from "react";

import type { ApiClient, Fetch } from "../data/api";
import type { Preferences } from "../data/preferences";
import type { Session } from "../data/session";
import { NavigationProvider } from "../ds";
import { SignInScreen } from "../screens/sign-in";
import { LiveProvider } from "../state/live";
import { navigate } from "../state/router";
import { ConsoleProvider } from "../state/services";
import { Shell } from "./shell";

// why: a sign-out anywhere comes straight back here, which unmounts the live data and closes its
// stream.
export function App(props: {
  readonly api: ApiClient;
  readonly fetch: Fetch;
  readonly preferences: Preferences;
  readonly session: Session;
}) {
  const { session } = props;
  const token = useSyncExternalStore(session.subscribe, session.token);
  return (
    <ConsoleProvider {...props}>
      <NavigationProvider navigate={navigate}>
        {token === undefined ? (
          <SignInScreen />
        ) : (
          <LiveProvider>
            <Shell />
          </LiveProvider>
        )}
      </NavigationProvider>
    </ConsoleProvider>
  );
}
