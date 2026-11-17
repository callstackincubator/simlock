import { describe, expect, it } from "vitest";

import { send, setUp, type Rig } from "./test-support.js";

const downloadLimit = 2_147_483_648;
const tooLargeReply = (size: number) => ({
  code: "INVALID_ARGS",
  error: `the download is ${String(size)} bytes; simlock carries downloads up to 2 GB (2147483648 bytes)`,
  ok: false,
  reason: "REFUSED_BY_SIMLOCK",
  retriable: false,
});

describe(
  "the agent-device front, through the whole worker daemon: downloads over 2 GiB",
  {
    timeout: 120_000,
  },
  () => {
    it("an artifact download whose `content-length` is 2147483649 is answered 413 with simlock's reply; the fake produced 0 bytes and its body was cancelled", async () => {
      const rig: Rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "size", size: downloadLimit + 1 });

      const response = await send(rig, "/artifacts/a1");

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(tooLargeReply(downloadLimit + 1));
      expect(rig.fake.artifactBytesProduced).toBe(0);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
    });

    it("an agent that cancels a 1 GiB download halfway cancels the fake's body", async () => {
      const rig: Rig = await setUp();
      rig.fake.serveArtifact({ contentLength: "none", size: 1_073_741_824 });

      const response = await send(rig, "/artifacts/a1");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let bytes = 0;
      while (bytes < 536_870_912) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
      }
      await reader.cancel();

      expect(bytes).toBeGreaterThanOrEqual(536_870_912);
      await expect.poll(() => rig.fake.artifactBodyCancelled).toBe(true);
      expect(rig.fake.artifactBytesProduced).toBeLessThan(1_073_741_824);
    });
  },
);
