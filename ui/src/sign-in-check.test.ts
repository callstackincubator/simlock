import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "./api";
import { checkToken, refusalMessage } from "./sign-in-check";

type Answer = number | "network-error" | "hang";

/** A daemon that answers `/v1/healthz` and `/v1/workers` as scripted. */
function daemon(healthz: Answer, workers: Answer): Fetch {
  return (input, init) => {
    const answer = input === "/v1/healthz" ? healthz : workers;
    if (answer === "network-error") return Promise.reject(new TypeError("Failed to fetch"));
    if (answer === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted")));
      });
    }
    return Promise.resolve(new Response("{}", { status: answer }));
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkToken", () => {
  it("signs in on a 200 from /v1/workers", async () => {
    expect(await checkToken("slk_op", daemon(200, 200))).toEqual({ kind: "signed-in" });
  });

  it("calls an unknown token unknown on a 401", async () => {
    const outcome = await checkToken("slk_nope", daemon(200, 401));

    expect(outcome).toEqual({ kind: "unknown-token" });
    expect(refusalMessage({ kind: "unknown-token" })).toBe("This daemon does not know that token.");
  });

  it("says the console needs an operator token on a 403", async () => {
    const outcome = await checkToken("slk_agent", daemon(200, 403));

    expect(outcome).toEqual({ kind: "not-operator" });
    expect(refusalMessage({ kind: "not-operator" })).toBe(
      "That token is real, but the console needs an operator token.",
    );
  });

  it("says the daemon is starting when /v1/workers gives no answer in 10 seconds while /v1/healthz answers", async () => {
    vi.useFakeTimers();
    const outcome = checkToken("slk_op", daemon(200, "hang"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await outcome).toEqual({ kind: "starting" });
    expect(refusalMessage({ kind: "starting" })).toBe(
      "The daemon is starting. Try again in a moment.",
    );
  });

  it("says the daemon cannot be reached when /v1/healthz does not answer", async () => {
    vi.useFakeTimers();
    const hung = checkToken("slk_op", daemon("hang", 200));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await checkToken("slk_op", daemon("network-error", 200))).toEqual({
      kind: "unreachable",
    });
    expect(await hung).toEqual({ kind: "unreachable" });
    expect(refusalMessage({ kind: "unreachable" })).toBe("The daemon cannot be reached.");
  });

  it("reports any other answer from /v1/workers with its status", async () => {
    const outcome = await checkToken("slk_op", daemon(200, 500));

    expect(outcome).toEqual({ kind: "failed", status: 500 });
    expect(refusalMessage({ kind: "failed", status: 500 })).toBe(
      "The daemon answered with an error (HTTP 500).",
    );
  });
});
