import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApiError, type ApiClient } from "../api";
import { ConsoleProvider } from "../console-context";
import type { Session } from "../session";
import { refusalOf, ScreenPane } from "./viewer";

/**
 * why: these are the sentences whoever pressed the button is left with, and each is the answer to a
 * different daemon refusal — so each is pinned to the status and the words that produce it, including
 * what the daemon's own refusal contributes.
 */
describe("what a refused stream says", () => {
  it("says which devices can be streamed when the daemon answers that this one cannot", () => {
    const refused = new ApiError(
      415,
      undefined,
      "This lease is not on an iOS simulator, and the PoC captures a screen only from a simulator",
    );

    expect(refusalOf(refused)).toBe(
      "This device cannot be streamed. A live screen is captured from an iOS simulator only.",
    );
  });

  it("keeps the daemon's own reason when it named one, and says what else to check", () => {
    const refused = new ApiError(404, undefined, "Unknown lease: lse_1");

    expect(refusalOf(refused)).toBe(
      "Unknown lease: lse_1 A stream is only offered where stream.enabled is on, and only for a lease that is still held.",
    );
  });

  it("keeps a capture program's own words when the worker could not run one", () => {
    const refused = new ApiError(
      500,
      undefined,
      "The screen capture produced no stream (the capture tool exited with code 1)",
    );

    expect(refusalOf(refused)).toBe(
      "The screen capture produced no stream (the capture tool exited with code 1)",
    );
  });

  it("keeps the daemon's words for a refusal this console has no advice about", () => {
    expect(refusalOf(new ApiError(401, "UNAUTHENTICATED", "Unknown bearer token"))).toBe(
      "Unknown bearer token",
    );
  });

  it("says what the browser itself threw, rather than that something went wrong", () => {
    expect(refusalOf(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
    expect(refusalOf("nope")).toBe("nope");
  });
});

describe("the pane before anything is asked for", () => {
  // why: a pane rendered for a claim about its markup never talks to a daemon, so the services it
  // reads are there to satisfy the context, and a call into either would be the finding.
  const services = {
    api: {} as unknown as ApiClient,
    session: {} as unknown as Session,
  };
  const html = renderToStaticMarkup(
    <ConsoleProvider {...services}>
      <ScreenPane leaseId="lse_1" />
    </ConsoleProvider>,
  );

  it("offers the one control a screen has, and says nothing runs while it is off", () => {
    expect(html).toContain("Show screen");
    expect(html).toContain("Nothing runs while this is off.");
    expect(html).toContain("No picture while this is off.");
  });

  it("shows the state as a word, and every figure it cannot yet fill as missing", () => {
    const words = [...html.matchAll(/<dt>([^<]*)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(
      ([, label = "", value = ""]) => `${label}=${value.replace(/<[^>]+>/g, "").trim()}`,
    );

    expect(words).toEqual([
      "State=off",
      "Picture=—",
      "Frames=—",
      "Rate=—",
      "Bandwidth=—",
      "Dropped=—",
    ]);
  });
});
