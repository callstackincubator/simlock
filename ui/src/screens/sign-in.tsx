import "./sign-in.css";

import { type FormEvent, type ReactNode, useState } from "react";

import { Button, Panel, Wordmark } from "../ds";
import { useReloadPage, useSignIn } from "../state/sign-in";

export function SignInScreen() {
  const [token, setToken] = useState("");
  const { checking, refusal, submit } = useSignIn();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(token.trim());
  };
  const refused = refusal !== undefined;

  return (
    <SignInFrame>
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
    </SignInFrame>
  );
}

function SignInFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="sign-in">
      <header className="sign-in-top">
        <Wordmark />
        <span className="byline">By Callstack</span>
      </header>
      <main className="sign-in-main">
        <div className="sign-in-panel">{children}</div>
      </main>
    </div>
  );
}

// why: shown while the first identity check runs, so a person behind a sign-in proxy never sees the
// token form flash.
export function SigningInScreen() {
  return (
    <SignInFrame>
      <Panel title="Signing in…" level={1}>
        <p role="status" className="hint">
          Checking who you are.
        </p>
      </Panel>
    </SignInFrame>
  );
}

export function SignInEndedScreen() {
  const reload = useReloadPage();
  return (
    <SignInFrame>
      <Panel title="Your sign-in has ended." level={1}>
        <div className="sign-in-form">
          <p className="hint">The sign-in proxy no longer knows you.</p>
          <div className="form-actions">
            <Button variant="primary" type="button" onClick={reload}>
              Sign in again
            </Button>
          </div>
        </div>
      </Panel>
    </SignInFrame>
  );
}
