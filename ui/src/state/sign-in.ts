import { useState } from "react";

import { checkToken, refusalMessage } from "../data/sign-in-check";
import { useFetch, useSession } from "./services";

export function useSignIn() {
  const fetch = useFetch();
  const session = useSession();
  const [checking, setChecking] = useState(false);
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
  return { checking, refusal, submit };
}
