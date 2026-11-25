import { describe, expect, it, vi } from "vitest";

import * as ports from "../ports/index.js";
import { setUp } from "./test-gateway.js";

vi.mock("../ports/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ports/index.js")>();
  return { ...actual, productionHostLoadProbe: vi.fn(actual.productionHostLoadProbe) };
});

// why: the probe is the only way a daemon reads the host's real memory, and a reading at memory pressure pauses the warm pool; a rig that builds it fails its warm-pool assertions whenever the machine running the suite is short of memory (#1863). Its first reading races the rig's first status read, so only the probe's construction is a deterministic witness. The worker rig's case is in `worker-rig-host-load.test.ts`: one file importing both rigs is a Fallow duplicate-export finding.
describe("the agent-device gateway test rig", { timeout: 30_000 }, () => {
  it("starts its gateway and worker daemons without building the host's real load probe", async () => {
    const built = vi.mocked(ports.productionHostLoadProbe);
    built.mockClear();

    await setUp();

    expect(built).toHaveBeenCalledTimes(0);
  });
});
