import { describe, expect, it } from "vitest";

import { FakeHttpStreamClient, MemoryFilesystem } from "../ports/index.js";
import type { HttpStreamAnswer, HttpStreamRequest } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, outputCapture, realCliEnvironmentPorts } from "./test-index.js";
import { FakeFarm } from "./test-remote.js";

const URL = "https://farm.example.com";
const AGENT_A = { SIMLOCK_AGENT_ID: "agent-a", SIMLOCK_TOKEN: "slk_t", SIMLOCK_URL: URL };

const lease = (id: string, requesterId: string) => ({ ...detachedGrant.lease, id, requesterId });

const answer = (status: number, body: unknown): HttpStreamAnswer => ({
  body: new Response(JSON.stringify(body)).body as ReadableStream<Uint8Array>,
  status,
});

async function drain(request: HttpStreamRequest): Promise<string> {
  return request.body === undefined ? "" : await new Response(request.body).text();
}

async function files(
  argv: readonly string[],
  reply: (request: HttpStreamRequest) => Promise<HttpStreamAnswer>,
) {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/work/project");
  await filesystem.writeFileAtomic("/work/project/app-debug.apk", "apk-bytes");
  const farm = new FakeFarm({ "lease.list": () => ({ leases: [lease("lse_1", "agent-a")] }) });
  const stream = new FakeHttpStreamClient();
  stream.reply = reply;
  const output = outputCapture(realCliEnvironmentPorts(filesystem), AGENT_A);
  const code = await runCli(argv, output.environmentWith({ httpStream: stream, webSocket: farm }));
  return { code, output, stream };
}

describe("CLI: simlock files", () => {
  it("moves files to and from the lease's folder on its worker, and refuses what cannot be moved", async () => {
    let uploaded = "";
    const put = await files(["files", "put", "app-debug.apk"], async (request) => {
      uploaded = await drain(request);
      return answer(201, { name: "app-debug.apk", size: 9 });
    });
    expect(put.code).toBe(0);
    expect(put.stream.requests).toEqual([
      { method: "PUT", token: "slk_t", url: `${URL}/v1/leases/lse_1/files/app-debug.apk` },
    ]);
    expect(uploaded).toBe("apk-bytes");
    expect(JSON.parse(put.output.stdout)).toEqual({
      lease: "lse_1",
      name: "app-debug.apk",
      size: 9,
    });
  });
});
