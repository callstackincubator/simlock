import { useState, useSyncExternalStore } from "react";

import type { ApiClient, Fetch } from "../data/api";
import type { Preferences } from "../data/preferences";
import type { Session } from "../data/session";
import {
  ConfirmHost,
  createConfirmer,
  createToaster,
  DesignProvider,
  NavigationProvider,
  ToastHost,
} from "../ds";
import { SignInEndedScreen, SignInScreen, SigningInScreen } from "../screens/sign-in";
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
  const [toaster] = useState(createToaster);
  const [confirmer] = useState(createConfirmer);
  const state = useSyncExternalStore(session.subscribe, session.state, session.state);
  return (
    <ConsoleProvider {...props} notify={toaster.notify} confirm={confirmer.confirm}>
      <NavigationProvider navigate={navigate}>
        <DesignProvider>
          {state.kind === "checking" ? (
            <SigningInScreen />
          ) : state.kind === "ended" ? (
            <SignInEndedScreen />
          ) : state.kind === "none" ? (
            <SignInScreen />
          ) : (
            <LiveProvider>
              <Shell />
            </LiveProvider>
          )}
          <ToastHost toaster={toaster} />
          <ConfirmHost confirmer={confirmer} />
        </DesignProvider>
      </NavigationProvider>
    </ConsoleProvider>
  );
}
