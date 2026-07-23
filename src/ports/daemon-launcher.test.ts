import { describe, expect, it } from "vitest";

import { FakeDaemonLauncher } from "./daemon-launcher.js";

describe("FakeDaemonLauncher", () => {
  it("records launches and delegates to its deterministic callback", async () => {
    let started = false;
    const launcher = new FakeDaemonLauncher(() => {
      started = true;
    });
    await launcher.launch();
    expect(launcher.launches).toBe(1);
    expect(started).toBe(true);
  });
});
