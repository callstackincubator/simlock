import { type FormEvent, useState } from "react";

import type { Fetch } from "./api";
import { useSession } from "./console-context";
import { Brand } from "./layout";
import { checkToken, refusalMessage } from "./sign-in-check";

/** Checks a pasted token and signs in with it, or keeps the reason it was refused. */
function useSignIn(fetch: Fetch) {
  const session = useSession();
  const [checking, setChecking] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  // No guard against a second submit while checking: the disabled button blocks it, the Enter
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

/** The screen a tab without a token sees (ADR 0011 §6). */
export function SignIn({ fetch }: { readonly fetch: Fetch }) {
  const [token, setToken] = useState("");
  const { checking, refusal, submit } = useSignIn(fetch);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(token.trim());
  };
  const refused = refusal !== undefined;

  return (
    <div className="sign-in">
      <header className="topbar">
        <Brand />
      </header>
      <main className="sign-in-main">
        <div className="panel sign-in-panel">
          <div className="panel-header">
            <div>
              <h1 className="panel-title">Sign in</h1>
              <p className="panel-description">The console needs an operator token.</p>
            </div>
          </div>
          <form className="panel-body" onSubmit={onSubmit} noValidate>
            <label htmlFor="token">Operator token</label>
            <input
              id="token"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              aria-describedby={refused ? "token-hint token-refusal" : "token-hint"}
              aria-invalid={refused || undefined}
            />
            <p id="token-hint" className="hint">
              Create one with <code>simlock token create --role operator</code>.
            </p>
            <Refusal message={refusal} />
            <div className="form-actions">
              <button className="button" type="submit" disabled={checking}>
                {checking ? "Checking…" : "Sign in"}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

function Refusal({ message }: { readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id="token-refusal" className="refusal" role="alert">
      {message}
    </p>
  );
}
