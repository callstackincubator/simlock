import { describe, expect, it } from "vitest";

import { FakeTcpProbe } from "../../ports/index.js";
import { AdbRegistrar } from "./adb-registrar.js";

describe("AdbRegistrar", () => {
  it("announces the emulator's adb port, not its console port, in adb's host framing", async () => {
    const tcp = new FakeTcpProbe();
    const registrar = new AdbRegistrar({ serverPort: 5038, tcp });

    await registrar.register(5587);

    // Four hex digits of length, big-endian, then the service: `host:emulator:5587`
    // is 18 characters, so `0012`.
    expect(tcp.sends).toEqual([{ payload: "0012host:emulator:5587", port: 5038 }]);
  });

  it("treats no reply at all as success", async () => {
    const tcp = new FakeTcpProbe();

    // adb's own source says of this service that "we don't even need to send a reply", so
    // silence is the ordinary answer rather than a lost round trip.
    await expect(
      new AdbRegistrar({ serverPort: 5038, tcp }).register(5587),
    ).resolves.toBeUndefined();
  });

  it("accepts adb's OKAY", async () => {
    const tcp = new FakeTcpProbe();
    tcp.replyWith("OKAY");

    await expect(
      new AdbRegistrar({ serverPort: 5038, tcp }).register(5587),
    ).resolves.toBeUndefined();
  });

  it("reports a refusal the server actually sent", async () => {
    const tcp = new FakeTcpProbe();
    tcp.replyWith("FAIL0014unknown host service");

    await expect(new AdbRegistrar({ serverPort: 5038, tcp }).register(5587)).rejects.toThrow(
      /host:emulator:5587/,
    );
  });

  it("propagates a connection that could not be made at all", async () => {
    const tcp = new FakeTcpProbe();
    tcp.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(new AdbRegistrar({ serverPort: 5038, tcp }).register(5587)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
