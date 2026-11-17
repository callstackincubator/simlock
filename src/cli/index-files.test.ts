import { describe, expect, it } from "vitest";

import { FakeClock, FakeHttpStreamClient, MemoryFilesystem } from "../ports/index.js";
import type { HttpStreamAnswer, HttpStreamRequest } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";
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
  readonly clock?: FakeClock;
  // why: a file that streams in this many one-byte pieces, as a 2 GiB build does in many.
  readonly pieces?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly leases?: readonly ReturnType<typeof lease>[];
  // why: a real filesystem leaves the bytes written so far when a stream fails; the in-memory one writes nothing, so a test asks for the leftover.
  readonly leavesPartial?: boolean;
  // why: files already in the working folder before the command runs.
  readonly existing?: Readonly<Record<string, string>>;
}

async function workerRoutes(request: HttpStreamRequest): Promise<HttpStreamAnswer> {
  if (request.method === "PUT") return stored(request);
  if (request.method === "DELETE") return { body: new Response("").body as never, status: 204 };
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
  await filesystem.writeFileAtomic("/work/project/big.bin", "");
  for (const [name, contents] of Object.entries(options.existing ?? {})) {
    await filesystem.writeFileAtomic(`/work/project/${name}`, contents);
  }
  if (options.leavesPartial === true) {
    const written = filesystem.writeFileStream.bind(filesystem);
    filesystem.writeFileStream = async (path, body, writeOptions) => {
      await filesystem.writeFileAtomic(path, "apk");
      await written(`${path}.discarded`, body, writeOptions);
      return 0;
    };
  }
  if (options.pieces !== undefined) {
    const pieces = options.pieces;
    const opened = filesystem.openFile.bind(filesystem);
    filesystem.openFile = async (path) =>
      path.endsWith("/big.bin")
        ? {
            close: async () => undefined,
            read: () => {
              let sent = 0;
              return new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (sent === pieces) controller.close();
                  else controller.enqueue(new Uint8Array([sent++]));
                },
              });
            },
            size: pieces,
          }
        : opened(path);
  }
  const output = outputCapture(
    { ...realCliEnvironmentPorts(filesystem), clock: options.clock ?? new FakeClock(0) },
    options.env ?? AGENT_A,
  );
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
    const strange = await files(["files", "list"], async () =>
      answer(500, { error: { code: "NOT_A_SIMLOCK_CODE", message: "boom" } }),
    );
    expect(strange.code).toBe(1);
    expect(JSON.parse(strange.output.stderr)).toEqual({
      error: { code: "REMOTE_UNREACHABLE", message: `The farm at ${URL} answered 500` },
    });
    const unreachable = await files(["files", "list"], async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(unreachable.code).toBe(1);
    expect(JSON.parse(unreachable.output.stderr)).toEqual({
      error: { code: "REMOTE_UNREACHABLE", message: `No answer from ${URL}` },
    });
    let sent = false;
    const cut = await files(
      ["files", "get", "app-debug.apk", "-o", "copy.apk"],
      async () => ({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) controller.error(new Error("socket hang up"));
            else controller.enqueue(new TextEncoder().encode("apk"));
            sent = true;
          },
        }),
        status: 200,
      }),
      { leavesPartial: true },
    );
    expect(cut.code).toBe(1);
    expect(JSON.parse(cut.output.stderr).error.code).toBe("REMOTE_UNREACHABLE");
    expect(await cut.filesystem.exists("/work/project/copy.apk")).toBe(false);
    expect(await cut.filesystem.exists("/work/project/copy.apk.part")).toBe(false);

    const localFailures: [string, string, Options?][] = [
      ["a folder that does not exist", "out/copy.apk"],
      ["a leftover part of another run", "copy.apk", { existing: { "copy.apk.part": "older" } }],
    ];
    for (const [title, output, options] of localFailures) {
      const refused = await files(
        ["files", "get", "app-debug.apk", "-o", output],
        workerRoutes,
        options,
      );
      expect(refused.code, title).toBe(1);
      expect(refused.output.stderr, title).not.toContain("REMOTE_UNREACHABLE");
      expect(refused.output.stderr, title).not.toContain("No answer from");
      if (options?.existing !== undefined) {
        expect(await refused.filesystem.readFile("/work/project/copy.apk.part"), title).toBe(
          "older",
        );
      }
    }

    const silent = new FakeClock(0);
    const abortedAfter: boolean[] = [];
    const stalled = await files(
      ["files", "put", "app-debug.apk"],
      async (request) => {
        silent.advance(59_999);
        abortedAfter.push(request.signal.aborted);
        silent.advance(1);
        abortedAfter.push(request.signal.aborted);
        throw new Error("aborted");
      },
      { clock: silent },
    );
    expect(abortedAfter, "after 59.999 s and after 60 s of silence").toEqual([false, true]);
    expect(stalled.code).toBe(1);
    expect(JSON.parse(stalled.output.stderr).error.code).toBe("REMOTE_UNREACHABLE");

    const moving = new FakeClock(0);
    const long = await files(
      ["files", "put", "big.bin"],
      async (request) => {
        const reader = (request.body as ReadableStream<Uint8Array>).getReader();
        let bytes = 0;
        for (let step = await reader.read(); !step.done; step = await reader.read()) {
          bytes += step.value.length;
          moving.advance(30_000);
        }
        abortedAfter.push(request.signal.aborted);
        return answer(201, { name: "big.bin", size: bytes });
      },
      { clock: moving, pieces: 40 },
    );
    expect(abortedAfter.at(-1), "a 20-minute upload with bytes moving").toBe(false);
    expect(long.code).toBe(0);
    expect(JSON.parse(long.output.stdout)).toEqual({ lease: "lse_1", name: "big.bin", size: 40 });
    expect(moving.now()).toBe(1_200_000);

    const slow = new FakeClock(0);
    let pulls = 0;
    const download = await files(
      ["files", "get", "app-debug.apk"],
      async (request) => ({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            slow.advance(10_000);
            if (request.signal.aborted) controller.error(new Error("aborted"));
            else if (pulls++ === 40) controller.close();
            else controller.enqueue(new Uint8Array([1]));
          },
        }),
        status: 200,
      }),
      { clock: slow },
    );
    expect(download.code, "a 400-second download with bytes moving").toBe(0);
    expect(download.output.stdout).toHaveLength(40);

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

describe("CLI: a remote simctl or adb that fails after naming a path on this machine", () => {
  async function passthrough(
    argv: readonly string[],
    exitCode: number,
    where: "farm" | "local" | "local gateway" = "farm",
  ) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/work/project/MyApp.app");
    await filesystem.writeFileAtomic("/work/project/app.apk", "apk-bytes");
    await filesystem.writeFileAtomic("/work/project/other.apk", "apk-bytes");
    const farm = new FakeFarm({
      "device.exec": () => ({ exitCode }),
      "lease.list": () => ({ leases: [lease("lse_1", "agent-a")] }),
    });
    const output = outputCapture(
      realCliEnvironmentPorts(filesystem),
      where === "farm" ? AGENT_A : { SIMLOCK_ADMIN_TOKEN: "admin", SIMLOCK_AGENT_ID: "agent-a" },
    );
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async (resolveCredential) => {
          await resolveCredential();
          return where === "local gateway"
            ? fakeClient({
                exec: async () => ({ exitCode }),
                getStatus: async () => ({
                  ...(await fakeClient().getStatus()),
                  daemon: { ...(await fakeClient().getStatus()).daemon, mode: "gateway" },
                }),
                listLeases: async () => ({ leases: [lease("lse_1", "agent-a")] }),
              })
            : fakeClient();
        },
        runPassthrough: async () => exitCode,
        webSocket: farm,
      }),
    );
    return { code, stderr: output.stderr };
  }

  const fileHint = (path: string) =>
    `${JSON.stringify({ notice: `${path} is on this machine, but the command ran on the worker; upload it with \`simlock files put ${path}\` and name it by its file name` })}\n`;
  const folderHint = (path: string) =>
    `${JSON.stringify({ notice: `${path} is a folder on this machine, and the command ran on the worker; a folder cannot be uploaded yet (#1636): install it with agent-device, or from a path on the worker` })}\n`;

  it("prints one hint for the first argument that names a path here, keeps the tool's exit code, and prints none on success, for no such path, or in local mode", async () => {
    const cases: [
      string,
      readonly string[],
      number,
      string,
      ("farm" | "local" | "local gateway")?,
    ][] = [
      ["a local file", ["adb", "install", "./app.apk"], 1, fileHint("./app.apk")],
      [
        "a local folder",
        ["simctl", "install", "booted", "./MyApp.app"],
        1,
        folderHint("./MyApp.app"),
      ],
      ["exit 0", ["simctl", "install", "booted", "./MyApp.app"], 0, ""],
      ["no such local path", ["adb", "install", "missing.apk"], 1, ""],
      [
        "two local paths",
        ["adb", "install-multiple", "app.apk", "other.apk"],
        1,
        fileHint("app.apk"),
      ],
      ["local mode", ["adb", "install", "app.apk"], 1, "", "local"],
      [
        "a gateway on this machine, with no --url",
        ["adb", "install", "app.apk"],
        1,
        "",
        "local gateway",
      ],
    ];
    for (const [title, argv, exitCode, hint, where] of cases) {
      const result = await passthrough(argv, exitCode, where);
      expect(result.code, title).toBe(exitCode);
      expect(result.stderr, title).toBe(hint);
    }
  });
});
