import { useState, useSyncExternalStore } from "react";

import { checkToken, refusalMessage } from "../data/sign-in-check";
import { proxyRefusalLine } from "../model/proxy-refusal";
import { useFetch, useSession } from "./services";

export function useSignIn() {
  const fetch = useFetch();
  const session = useSession();
  const [checking, setChecking] = useState(false);
  const state = useSyncExternalStore(session.subscribe, session.state, session.state);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  // why: no guard against a second submit while checking: the disabled button blocks it, the Enter
  // key included, since a form with a disabled submit button does not submit implicitly.
  const submit = async (token: string) => {
    if (token === "") return;
    setChecking(true);
    setRefusal(undefined);
    const outcome = await checkToken(token, fetch);
    setChecking(false);
    if (outcome.kind === "signed-in") session.signIn(token);
    else setRefusal(refusalMessage(outcome));
  };
  const proxyRefusal =
    state.kind === "none" && state.refusedReason !== undefined
      ? proxyRefusalLine(state.refusedReason)
      : undefined;
  return { checking, refusal: refusal ?? proxyRefusal, submit };
}

export function useReloadPage(): () => void {
  return () => window.location.reload();
}
