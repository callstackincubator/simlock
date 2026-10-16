import "./sign-in.css";

import { type FormEvent, useState } from "react";

import { Button, Panel, Wordmark } from "../ds";
import { useSignIn } from "../state/sign-in";

export function SignInScreen() {
  const [token, setToken] = useState("");
  const { checking, refusal, submit } = useSignIn();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(token.trim());
  };
  const refused = refusal !== undefined;

  return (
    <div className="sign-in">
      <header className="sign-in-top">
        <Wordmark />
        <span className="byline">By Callstack</span>
      </header>
      <main className="sign-in-main">
        <div className="sign-in-panel">
          <Panel title="Sign in" level={1}>
            <form className="sign-in-form" onSubmit={onSubmit} noValidate>
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
              {refusal === undefined ? null : (
                <p id="token-refusal" className="refusal" role="alert">
                  {refusal}
                </p>
              )}
              <div className="form-actions">
                <Button variant="primary" type="submit" disabled={checking}>
                  {checking ? "Checking…" : "Sign in"}
                </Button>
              </div>
            </form>
          </Panel>
        </div>
      </main>
    </div>
  );
}
