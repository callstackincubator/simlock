import { describe, expect, it } from "vitest";

import { tokenIdentity } from "../../auth/testing.js";
import { FakeAgentDevice, type FakeArtifact } from "../testing.js";
import { AgentDeviceHost } from "./host.js";

const downloadLimit = 2_147_483_648;

// why: the host is called with no socket between, so 2 GiB passes through it in well under a second.
async function download(artifact: FakeArtifact) {
  const fake = new FakeAgentDevice();
  fake.serveArtifact(artifact);
  const host = new AgentDeviceHost(fake, ["ios"]);
  const response = await host.forward(
    new Request("http://worker/v1/agent-device/artifacts/a1"),
    tokenIdentity("tok_agent"),
  );
  let bytes = 0;
  let ended = false;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      bytes += next.value.length;
    }
  } catch {
    ended = false;
  }
  return { bytes, ended, fake, status: response.status };
}

describe("the agent-device host's download cap", () => {
  it.each(["size", "none"] as const)(
    "a download of exactly 2147483648 bytes with `content-length` %s is passed on whole and ends cleanly",
    async (contentLength) => {
      const received = await download({ contentLength, size: downloadLimit });

      expect(received).toMatchObject({ bytes: downloadLimit, ended: true, status: 200 });
    },
  );

  it("a download with no `content-length` that passes 2147483648 bytes errors the response, which never ends cleanly nor delivers more than 2147483648 bytes, and the daemon's body is cancelled", async () => {
    const received = await download({ contentLength: "none", size: downloadLimit + 1 });

    expect(received.ended).toBe(false);
    expect(received.bytes).toBeLessThanOrEqual(downloadLimit);
    await expect.poll(() => received.fake.artifactBodyCancelled).toBe(true);
  });
});
