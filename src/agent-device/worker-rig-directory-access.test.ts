import { describe, expect, it, vi } from "vitest";

import { setUpWithPhone } from "./test-edge.js";
import { setUp } from "./test-support.js";

const built = vi.hoisted(() => ({ count: 0 }));

vi.mock("../ports/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ports/index.js")>();
  class CountedReader extends actual.PowerShellDirectoryAccessReader {
    constructor(...args: ConstructorParameters<typeof actual.PowerShellDirectoryAccessReader>) {
      super(...args);
      built.count += 1;
    }
  }
  return { ...actual, PowerShellDirectoryAccessReader: CountedReader };
});

// why: on Windows every daemon start waits on the real reader, a `powershell.exe` run of up to 10 s, before it serves; a rig that builds it spends its test's 20 s budget on PowerShell whenever the runner is loaded (#1912). The reader runs only on win32, so only its construction is a witness on every OS.
describe("the agent-device worker test rig", { timeout: 30_000 }, () => {
  it("starts its daemon, the phone rig's daemon and a restarted daemon without building the host's real directory-access reader", async () => {
    built.count = 0;

    const rig = await setUp();
    expect(built.count, "after setUp").toBe(0);
    await setUpWithPhone();
    expect(built.count, "after setUpWithPhone").toBe(0);
    await rig.restart();
    expect(built.count, "after restart").toBe(0);
  });
});
