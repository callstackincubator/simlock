import { describe, expect, it } from "vitest";

import { agentAuth, buildHarness } from "../http/test-app.js";
import { makeLease } from "../http/test-fakes.js";
import { MAX_FILE_BYTES } from "../lease-files/index.js";
import { createGatewayLeaseFiles } from "./gateway-lease-files.js";

describe("a gateway's lease files", () => {
  it("refuses a declared size over the limit with 413 FILE_TOO_LARGE, relays nothing, and its request line names the code", async () => {
    const relayed: string[] = [];
    const rig = buildHarness({
      leaseFiles: () =>
        createGatewayLeaseFiles({
          relay: (workerId) => {
            relayed.push(workerId);
            return Promise.resolve(new Response(null, { status: 204 }));
          },
          requesterPrefix: "gw:",
        }),
    });
    rig.registry.leases = [makeLease({ id: "lse_1", ownerId: "tok_agent" })];

    const response = await rig.app.request("/v1/leases/lse_1/files/huge.bin", {
      headers: { ...agentAuth, "content-length": String(MAX_FILE_BYTES + 1) },
      method: "PUT",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "FILE_TOO_LARGE",
        message: "File huge.bin is over the 2 GiB limit for one file",
        name: "huge.bin",
      },
    });
    expect(relayed).toEqual([]);
    expect(rig.logSink.records.filter((record) => record.message === "request")).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ code: "FILE_TOO_LARGE", status: 413 }),
      }),
    ]);
  });
});
