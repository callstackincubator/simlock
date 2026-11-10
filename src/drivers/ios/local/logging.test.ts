import { describe, expect, it } from "vitest";

import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../../../ports/index.js";
import { logSilenceFailure, logWindowFailure } from "./logging.js";

// why: the backend logging adapter is pure logic with multiple failure cases.
describe("the iOS driver's failure logs", () => {
  it.each([
    { name: "silence", log: logSilenceFailure, message: "Could not silence iOS simulator" },
    { name: "window", log: logWindowFailure, message: "Could not open a window for iOS simulator" },
  ])(
    "logs one warning, with the device id and the detail, when a simulator could not be made $name",
    ({ log, message }) => {
      const sink = new MemoryLogSink();

      log(new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink }))({
        deviceId: "simlock-ios-1",
        detail: "timed out",
      });

      expect(sink.records).toEqual([
        expect.objectContaining({
          fields: { deviceId: "simlock-ios-1", detail: "timed out" },
          level: "warn",
          message,
        }),
      ]);
    },
  );
});
