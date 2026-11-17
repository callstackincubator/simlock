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

interface Options {
  readonly env?: NodeJS.ProcessEnv;
  readonly leases?: readonly ReturnType<typeof lease>[];
}

async function files(
  argv: readonly string[],
  reply: (request: HttpStreamRequest) => Promise<HttpStreamAnswer>,
  options: Options = {},
) {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/work/project/build");
  await filesystem.writeFileAtomic("/work/project/app-debug.apk", "apk-bytes");
  const leases = options.leases ?? [lease("lse_1", "agent-a")];
  const farm = new FakeFarm({ "lease.list": () => ({ leases }) });
  const stream = new FakeHttpStreamClient();
  stream.reply = reply;
  const output = outputCapture(realCliEnvironmentPorts(filesystem), options.env ?? AGENT_A);
  const code = await runCli(argv, output.environmentWith({ httpStream: stream, webSocket: farm }));
  return { code, farm, output, stream };
}

const stored = async (request: HttpStreamRequest) => {
  await drain(request);
  return answer(201, { name: request.url.split("/").at(-1), size: 9 });
};

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

    const named = await files(["files", "put", "app-debug.apk", "--name", "app.apk"], stored);
    expect(named.stream.requests.map(({ url }) => url)).toEqual([
      `${URL}/v1/leases/lse_1/files/app.apk`,
    ]);
    expect(JSON.parse(named.output.stdout)).toMatchObject({ name: "app.apk" });

    const refused: [string, readonly string[], string, Options?][] = [
      ["a missing local file", ["put", "nothing.apk"], "No file nothing.apk"],
      ["a folder", ["put", "build"], "build is a folder; a folder cannot be uploaded yet (#1636)"],
      [
        "local mode",
        ["put", "app-debug.apk"],
        "simlock files needs --url or SIMLOCK_URL: on the daemon's machine the lease's folder is a local folder",
        { env: { SIMLOCK_AGENT_ID: "agent-a" } },
      ],
      [
        "no lease of this requester",
        ["put", "app-debug.apk"],
        "No lease is held by agent-a: run `simlock lease` first, or set SIMLOCK_AGENT_ID to the id that holds it",
        { leases: [lease("lse_9", "agent-b")] },
      ],
      [
        "two leases of this requester",
        ["put", "app-debug.apk"],
        "agent-a holds more than one lease (lse_1, lse_2); pass --lease <id> to name the device you mean",
        { leases: [lease("lse_1", "agent-a"), lease("lse_2", "agent-a")] },
      ],
    ];
    for (const [title, words, message, options] of refused) {
      const result = await files(["files", ...words], stored, options);
      expect(result.code, title).toBe(2);
      expect(result.output.stderr, title).toContain(message);
      expect(result.stream.requests, title).toEqual([]);
    }
    const named_lease = await files(["files", "put", "app-debug.apk", "--lease", "lse_9"], stored, {
      leases: [lease("lse_9", "agent-b")],
    });
    expect(named_lease.code).toBe(0);
    expect(named_lease.stream.requests.map(({ url }) => url)).toEqual([
      `${URL}/v1/leases/lse_9/files/app-debug.apk`,
    ]);
  });
});
