import { describe, expect, it } from "vitest";
import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: the iOS modes a worker serves", () => {
  it("refuses an iOS lease whose resolved mode ios.modes does not list with MODE_UNAVAILABLE and its details, and grants a served one", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: { slimmableOsVersions: ["26.5"] },
      iosModes: ["slim"],
    });
    const request = { model: "iPhone 17 Pro", platform: "ios" } as const;

    const granted = await dispatcher.dispatch(
      "lease.request",
      { ...request, mode: "slim" },
      session(),
    );
    expect(granted.device.mode).toBe("slim");

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { ...request, mode: "full" },
        session({ principal: "tok_other" }),
      ),
    ).rejects.toMatchObject({
      code: "MODE_UNAVAILABLE",
      details: { mode: "full", platform: "ios", served: ["slim"] },
    });
  });
});
