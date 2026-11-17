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

async function workerRoutes(request: HttpStreamRequest): Promise<HttpStreamAnswer> {
  if (request.method === "PUT") return stored(request);
  if (request.method === "DELETE") return { body: new Response(null).body as never, status: 204 };
  if (request.url.endsWith("/files")) {
    return answer(200, { files: [{ name: "app-debug.apk", size: 9 }] });
  }
  return { body: new Response("apk-bytes").body as never, status: 200 };
}

async function files(
  argv: readonly string[],
  reply: (request: HttpStreamRequest) => Promise<HttpStreamAnswer> = workerRoutes,
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
  return { code, farm, filesystem, output, stream };
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

    const get = await files(["files", "get", "app-debug.apk"]);
    expect(get.code).toBe(0);
    expect(get.stream.requests).toEqual([
      { method: "GET", token: "slk_t", url: `${URL}/v1/leases/lse_1/files/app-debug.apk` },
    ]);
    expect(get.output.stdout).toBe("apk-bytes");
    const saved = await files(["files", "get", "app-debug.apk", "-o", "copy.apk"]);
    expect(saved.code).toBe(0);
    expect(await saved.filesystem.readFile("/work/project/copy.apk")).toBe("apk-bytes");
    expect(saved.output.stdout).toBe("");

    const listed = await files(["files", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stream.requests).toEqual([
      { method: "GET", token: "slk_t", url: `${URL}/v1/leases/lse_1/files` },
    ]);
    expect(JSON.parse(listed.output.stdout)).toEqual({
      files: [{ name: "app-debug.apk", size: 9 }],
    });

    const removed = await files(["files", "rm", "app-debug.apk"]);
    expect(removed.code).toBe(0);
    expect(removed.stream.requests).toEqual([
      { method: "DELETE", token: "slk_t", url: `${URL}/v1/leases/lse_1/files/app-debug.apk` },
    ]);
    expect(removed.output.stdout).toBe("");

    const failures: [string, readonly string[], number, string, number][] = [
      ["FILE_TOO_LARGE", ["put", "app-debug.apk"], 413, "FILE_TOO_LARGE", 1],
      ["LEASE_FILES_FULL", ["put", "app-debug.apk"], 413, "LEASE_FILES_FULL", 1],
      ["FILE_BUSY", ["put", "app-debug.apk"], 409, "FILE_BUSY", 1],
      ["INSUFFICIENT_DISK_SPACE", ["put", "app-debug.apk"], 422, "INSUFFICIENT_DISK_SPACE", 12],
      ["UPLOAD_STALLED", ["put", "app-debug.apk"], 408, "UPLOAD_STALLED", 1],
      ["UNKNOWN_LEASE", ["list"], 404, "UNKNOWN_LEASE", 1],
      ["UNKNOWN_FILE on get", ["get", "gone.apk"], 404, "UNKNOWN_FILE", 1],
      ["UNKNOWN_FILE on rm", ["rm", "gone.apk"], 404, "UNKNOWN_FILE", 1],
      ["UNAUTHENTICATED", ["get", "app-debug.apk"], 401, "UNAUTHENTICATED", 1],
    ];
    for (const [title, words, status, code, exit] of failures) {
      const result = await files(["files", ...words], async () =>
        answer(status, { error: { code, message: `m ${code}` } }),
      );
      expect(result.code, title).toBe(exit);
      expect(JSON.parse(result.output.stderr), title).toEqual({
        error: { code, message: `m ${code}` },
      });
      expect(result.output.stdout, title).toBe("");
    }
    const unreachable = await files(["files", "list"], async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(unreachable.code).toBe(1);
    expect(JSON.parse(unreachable.output.stderr)).toEqual({
      error: { code: "REMOTE_UNREACHABLE", message: `No answer from ${URL}` },
    });
    let sent = false;
    const cut = await files(["files", "get", "app-debug.apk", "-o", "copy.apk"], async () => ({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error("socket hang up"));
          else controller.enqueue(new TextEncoder().encode("apk"));
          sent = true;
        },
      }),
      status: 200,
    }));
    expect(cut.code).toBe(1);
    expect(JSON.parse(cut.output.stderr).error.code).toBe("REMOTE_UNREACHABLE");
    expect(await cut.filesystem.exists("/work/project/copy.apk")).toBe(false);
    expect(await cut.filesystem.exists("/work/project/copy.apk.part")).toBe(false);

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
