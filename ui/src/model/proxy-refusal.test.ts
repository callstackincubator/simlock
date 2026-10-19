import { describe, expect, it } from "vitest";

import { proxyRefusalLine } from "./proxy-refusal";

const line = (why: string) =>
  `Your sign-in proxy's identity was refused: ${why}. You can still sign in with an operator token.`;

describe("proxyRefusalLine", () => {
  it("says why the proxy's identity was refused for each reason, and that it was refused for one it does not know", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["expired", "it has expired"],
      ["not-yet-valid", "it is not valid yet; check this machine's clock"],
      ["wrong-issuer", "it comes from a different sign-in service than this daemon expects"],
      ["wrong-audience", "it was made for a different application"],
      ["unknown-key", "its signature does not check out"],
      ["bad-signature", "its signature does not check out"],
      ["algorithm", "it is signed in a way this daemon does not accept"],
      ["malformed", "it is not a valid sign-in token"],
      ["keys-unavailable", "this daemon cannot reach the sign-in service's keys"],
      ["something-new", "it was refused"],
      ["constructor", "it was refused"],
    ];

    expect(cases.map(([reason]) => proxyRefusalLine(reason))).toEqual(
      cases.map(([, why]) => line(why)),
    );
  });
});
