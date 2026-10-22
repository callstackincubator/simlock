import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createApiClient } from "../data/api";
import { createPreferences } from "../data/preferences";
import { createSession } from "../data/session";
import { ConsoleProvider } from "../state/services";
import { SignInScreen } from "./sign-in";

function services() {
  const fetch = () => Promise.reject(new Error("no network in this test"));
  const storage = { getItem: () => null, removeItem: () => undefined, setItem: () => undefined };
  const session = createSession(() => storage);
  return {
    api: createApiClient({ fetch, signOut: session.signOut, token: session.token }),
    confirm: () => Promise.resolve(),
    fetch,
    notify: () => undefined,
    preferences: createPreferences(() => storage),
    session,
  };
}

describe("the sign-in screen", () => {
  it("asks for an operator token, says how to make one, and shows no refusal before a try", () => {
    const html = renderToStaticMarkup(
      <ConsoleProvider {...services()}>
        <SignInScreen />
      </ConsoleProvider>,
    );

    expect(html).toContain('<h1 id="');
    expect(html).toMatch(/<label for="token">Operator token<\/label>/);
    expect(html).toContain('aria-describedby="token-hint"');
    expect(html).toContain("simlock token create --role operator");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Sign in<\/button>/);
    expect(html).not.toContain('role="alert"');
  });
});
