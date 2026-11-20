import { describe, expect, it } from "vitest";

import { signInHref } from "./sign-in-url";

describe("signInHref", () => {
  it("replaces {path} with the encoded path and search, uses a URL without it as written, and refuses what is not http or https once replaced", () => {
    const cases: readonly (readonly [unknown, string | undefined])[] = [
      [
        "https://fleet.example.com/oauth2/start?rd={path}",
        "https://fleet.example.com/oauth2/start?rd=%2Fleases%2Fl_1%3Ftab%3Dall%26x%3D1",
      ],
      ["https://login.example.test/start?rd=/", "https://login.example.test/start?rd=/"],
      ["{path}", undefined],
      ["javascript:alert(1)", undefined],
      ["//login.example.test/start", undefined],
      [42, undefined],
    ];
    for (const [template, href] of cases) {
      expect(signInHref(template, "/leases/l_1?tab=all&x=1"), String(template)).toBe(href);
    }
  });
});
