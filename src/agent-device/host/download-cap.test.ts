import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { tokenIdentity } from "../../auth/testing.js";
import { FakeAgentDevice } from "../testing.js";
import { AgentDeviceHost } from "./host.js";

const LIMIT = 2_147_483_648;
const identity = tokenIdentity("tok_a");

function download(): Request {
  return new Request("http://simlock.test/v1/agent-device/artifacts/a1", {
    headers: { authorization: "Bearer slk_test_agent" },
  });
}

async function drain(response: Response): Promise<{
  readonly bytes: number;
  readonly digest: string;
  readonly error: unknown;
  readonly ended: boolean;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { bytes, digest: hash.digest("hex"), error: undefined, ended: true };
      hash.update(next.value);
      bytes += next.value.length;
    }
  } catch (error) {
    return { bytes, digest: "", error, ended: false };
  }
}

function hostFor(fake: FakeAgentDevice): AgentDeviceHost {
  return new AgentDeviceHost(fake, ["ios"]);
}

describe("the agent-device host's download cap, called directly", { timeout: 120_000 }, () => {
  it.each(["3e9", "2147483649, 2147483649", "9007199254740993"])(
    "a content-length of %s is counted as absent: the body is counted, and one passing 2147483648 bytes under it errors",
    async (contentLength) => {
      const fake = new FakeAgentDevice();
      fake.serveArtifact({ contentLength, size: LIMIT + 1 });

      const response = await hostFor(fake).forward(download(), identity);
      expect(response.status).toBe(200);
      const result = await drain(response);

      expect(result.ended).toBe(false);
      expect(result.error).toBeDefined();
      expect(fake.artifactBodyCancelled).toBe(true);
    },
  );

  it("a 2 GiB download whose body nobody reads leaves the fake having produced at most 128 KiB after 1 s", async () => {
    const fake = new FakeAgentDevice();
    fake.serveArtifact({ contentLength: "none", size: LIMIT });

    const response = await hostFor(fake).forward(download(), identity);
    expect(response.status).toBe(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));

    expect(fake.artifactBytesProduced).toBeLessThanOrEqual(128 * 1024);
    await response.body?.cancel();
  });
});
