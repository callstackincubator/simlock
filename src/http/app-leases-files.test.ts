import { createHash, randomFillSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLeaseFiles, type LeaseFilesLimits } from "../lease-files/index.js";
import { NodeFilesystem } from "../ports/index.js";
import { agentAuth, buildHarness, operatorAuth, otherAgentAuth } from "./test-app.js";
import { makeLease, sequenceIdGenerator } from "./test-fakes.js";

const filesRoots: string[] = [];

afterEach(async () => {
  await Promise.all(filesRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// why: a worker's HTTP app over a real lease-files store in a temporary folder, with lease `lse_1` held by `tok_agent`.
async function filesRig(
  options: {
    readonly limits?: LeaseFilesLimits;
    readonly filesystem?: NodeFilesystem;
    readonly diskPressureThreshold?: number;
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-lease-files-"));
  filesRoots.push(dataDirectory);
  const rig = buildHarness({
    leaseFiles: ({ clock, logger }) =>
      createLeaseFiles({
        clock,
        dataDirectory,
        diskPressureThreshold: options.diskPressureThreshold ?? 0,
        filesystem: options.filesystem ?? new NodeFilesystem(),
        findGrant: (leaseId) =>
          leaseId === "lse_1" ? { grantedAt: 1_000, id: leaseId, platform: "ios" } : undefined,
        idGenerator: sequenceIdGenerator("up"),
        logger,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
  });
  rig.registry.leases = [makeLease({ id: "lse_1", ownerId: "tok_agent" })];
  const put = (name: string, body: BodyInit, headers: Record<string, string> = agentAuth) =>
    rig.app.request(`/v1/leases/lse_1/files/${name}`, { body, headers, method: "PUT" });
  const get = (name: string, headers: Record<string, string> = agentAuth) =>
    rig.app.request(`/v1/leases/lse_1/files/${name}`, { headers });
  const remove = (name: string, headers: Record<string, string> = agentAuth) =>
    rig.app.request(`/v1/leases/lse_1/files/${name}`, { headers, method: "DELETE" });
  const list = (headers: Record<string, string> = agentAuth) =>
    rig.app.request("/v1/leases/lse_1/files", { headers });
  const leaseFolder = join(
    dataDirectory,
    "lease-files",
    `${Buffer.from("lse_1").toString("hex")}-1000`,
  );
  return { ...rig, dataDirectory, get, leaseFolder, list, put, remove };
}

// why: what a lease folder holds, temporary upload files included, so "nothing stored" means nothing on disk.
async function folderEntries(folder: string): Promise<string[]> {
  return readdir(folder).catch(() => []);
}

// why: a request body the test feeds by hand: `push` resolves once the upload has taken the bytes and asks for more, so a test acts only after the store has seen them.
function liveBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let waiting: (() => void)[] = [];
  let pulled!: () => void;
  const firstPull = new Promise<void>((resolve) => {
    pulled = resolve;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        pulled();
        for (const resume of waiting.splice(0)) resume();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    fail: (error: Error) => controller.error(error),
    finish: () => controller.close(),
    firstPull,
    push: (bytes: Uint8Array) =>
      new Promise<void>((resolve) => {
        controller.enqueue(bytes);
        waiting = [...waiting, resolve];
      }),
    stream,
  };
}

// why: a request the code under test must answer; when it never does, the assertion on `undefined` fails by name where an await would time the whole test out.
function answered(
  response: Promise<Response> | Response,
  waitMs = 2_000,
): Promise<Response | undefined> {
  return Promise.race([
    Promise.resolve(response),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs)),
  ]);
}

// why: counts the files opened and not yet closed, so a test sees a response that left one open.
class CountingFilesystem extends NodeFilesystem {
  open = 0;
  override async openFile(path: string) {
    const file = await super.openFile(path);
    this.open += 1;
    let closed = false;
    const release = () => {
      if (!closed) this.open -= 1;
      closed = true;
    };
    return {
      size: file.size,
      read: (range?: { readonly start: number; readonly end: number }) => {
        const stream = file.read(range);
        const reader = stream.getReader();
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            const piece = await reader.read();
            if (piece.done) {
              release();
              controller.close();
            } else controller.enqueue(piece.value);
          },
          async cancel(reason) {
            release();
            await reader.cancel(reason);
          },
        });
      },
      close: async () => {
        release();
        await file.close();
      },
    };
  }
}

class LowDiskFilesystem extends NodeFilesystem {
  override diskFree(): Promise<number> {
    return Promise.resolve(5 * 1024 ** 3);
  }
}

// why: comparing megabytes with `toEqual` walks them one by one and takes seconds; their digests say the same.
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("a lease's files on a worker", () => {
  it("a lease holder PUTs a file and gets 201 with its name and size; a GET returns the same bytes", async () => {
    const { get, put } = await filesRig();
    const patterned = (length: number): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(length);
      randomFillSync(bytes.subarray(0, Math.min(length, 1 << 20)));
      for (let at = 1 << 20; at < length; at += 1 << 20) bytes.copyWithin(at, 0, 1 << 20);
      return bytes;
    };
    const cases: [string, Uint8Array<ArrayBuffer>][] = [
      ["fixture.tar", patterned(3 * 1024 * 1024)],
      ["fixture.tar", patterned(1000)],
      ["empty.bin", new Uint8Array(0)],
      ["big.bin", patterned(70_000_000)],
    ];

    for (const [name, bytes] of cases) {
      const response = await put(name, bytes);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ name, size: bytes.length });
      const download = await get(name);
      expect(download.status).toBe(200);
      expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(bytes));
    }
  });

  it("a lease holder PUTs a bad file name and gets 400 BAD_REQUEST with the name rule", async () => {
    const { get, put, app } = await filesRig();
    const accepted = [
      "fixture.tar",
      "app-release.apk",
      "Documents.tar.deflate",
      "A",
      "a".repeat(128),
    ];
    const refused = [
      ["a".repeat(129), "a".repeat(129)],
      [".hidden", ".hidden"],
      ["-rf", "-rf"],
      ["my%20file.tar", "my file.tar"],
      ["a%2Fb.tar", "a/b.tar"],
      ["za%C5%BC%C3%B3%C5%82%C4%87.txt", "zażółć.txt"],
    ] as const;

    for (const name of accepted) expect((await put(name, "x")).status).toBe(201);
    for (const [encoded, decoded] of refused) {
      for (const response of [await put(encoded, "x"), await get(encoded)]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: {
            code: "BAD_REQUEST",
            message: `File ${decoded} must be 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit`,
          },
        });
      }
    }
    expect((await app.request("/v1/leases/lse_1/files/..", { headers: agentAuth })).status).toBe(
      404,
    );
  });

  it("a lease holder PUTs past a limit and gets the limit's code, with nothing stored and the previous file kept", async () => {
    const limits = { fileBytes: 10, leaseBytes: 100, silenceMs: 330_000 };
    const big = new Uint8Array(11);
    const rig = await filesRig({ limits });
    const refusal = async (response: Response) =>
      (await response.json()) as { error: { code: string; message: string } };
    const text = async (response: Response) =>
      new TextDecoder().decode(await response.arrayBuffer());

    expect((await rig.put("kept.bin", "1234567890")).status).toBe(201);
    const tooBig = await rig.put("kept.bin", big);
    expect(tooBig.status).toBe(413);
    expect((await refusal(tooBig)).error).toEqual({
      code: "FILE_TOO_LARGE",
      message: "File kept.bin is over the 2 GiB limit for one file",
      name: "kept.bin",
    });
    expect(await text(await rig.get("kept.bin"))).toBe("1234567890");
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);

    let pulled = false;
    const unread = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulled = true;
            c.close();
          },
        },
        { highWaterMark: 0 },
      );
    const declared = await rig.app.request("/v1/leases/lse_1/files/declared.bin", {
      body: unread(),
      duplex: "half",
      headers: { ...agentAuth, "content-length": "11" },
      method: "PUT",
    } as RequestInit);
    expect(declared.status).toBe(413);
    expect((await refusal(declared)).error.code).toBe("FILE_TOO_LARGE");
    expect(pulled).toBe(false);
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);

    const roomy = { fileBytes: 1000, leaseBytes: 100, silenceMs: 330_000 };
    const full = await filesRig({ limits: roomy });
    await mkdir(full.leaseFolder, { recursive: true });
    await writeFile(join(full.leaseFolder, "my file.png"), new Uint8Array(60));
    expect((await full.put("fits.bin", new Uint8Array(40))).status).toBe(201);
    await rm(join(full.leaseFolder, "fits.bin"));
    for (const headers of [agentAuth, { ...agentAuth, "content-length": "50" }]) {
      const over = await full.put("over.bin", new Uint8Array(50), headers);
      expect(over.status).toBe(413);
      expect((await refusal(over)).error).toEqual({
        code: "LEASE_FILES_FULL",
        leaseId: "lse_1",
        message: "Lease lse_1 holds 60 bytes of files; this upload would pass the 4 GiB limit",
        usedBytes: 60,
      });
      expect(await folderEntries(full.leaseFolder)).toEqual(["my file.png"]);
    }
    pulled = false;
    const declaredFull = await full.app.request("/v1/leases/lse_1/files/over.bin", {
      body: unread(),
      duplex: "half",
      headers: { ...agentAuth, "content-length": "50" },
      method: "PUT",
    } as RequestInit);
    expect(declaredFull.status).toBe(413);
    expect((await refusal(declaredFull)).error.code).toBe("LEASE_FILES_FULL");
    expect(pulled).toBe(false);

    const together = await filesRig({ limits: roomy });
    const first = liveBody();
    const running = together.app.request("/v1/leases/lse_1/files/a.bin", {
      body: first.stream,
      duplex: "half",
      headers: agentAuth,
      method: "PUT",
    } as RequestInit);
    await first.push(new Uint8Array(60));
    const second = await together.put("b.bin", new Uint8Array(60));
    expect(second.status).toBe(413);
    expect((await refusal(second)).error.code).toBe("LEASE_FILES_FULL");
    first.finish();
    expect((await running).status).toBe(201);
    expect(await folderEntries(together.leaseFolder)).toEqual(["a.bin"]);

    const chunked = await filesRig({ limits: roomy });
    const chunks = liveBody();
    const chunkedRequest = chunked.app.request("/v1/leases/lse_1/files/chunks.bin", {
      body: chunks.stream,
      duplex: "half",
      headers: agentAuth,
      method: "PUT",
    } as RequestInit);
    for (let piece = 0; piece < 3; piece += 1) {
      await Promise.race([chunks.push(new Uint8Array(30)), chunkedRequest]);
    }
    chunks.finish();
    expect((await chunkedRequest).status).toBe(201);
    expect(await folderEntries(chunked.leaseFolder)).toEqual(["chunks.bin"]);

    const replacing = await filesRig({ limits: roomy });
    expect((await replacing.put("x.bin", new Uint8Array(80))).status).toBe(201);
    expect((await replacing.put("x.bin", new Uint8Array(80))).status).toBe(201);

    const lowDisk = await filesRig({
      diskPressureThreshold: 10 * 1024 ** 3,
      filesystem: new LowDiskFilesystem(),
    });
    const noDisk = await lowDisk.put("fixture.tar", "x");
    expect(noDisk.status).toBe(422);
    expect((await refusal(noDisk)).error).toEqual({
      availableBytes: 5 * 1024 ** 3,
      code: "INSUFFICIENT_DISK_SPACE",
      message:
        "Not enough free disk space to store fixture.tar: the worker keeps 10.0 GiB free, only 5.0 GiB available",
      platform: "ios",
      requiredBytes: 10 * 1024 ** 3,
    });
    expect(await folderEntries(lowDisk.leaseFolder)).toEqual([]);
  });

  it("a lease holder whose PUT is cut or goes silent keeps the previous file or none; a second PUT to a name being uploaded gets 409 FILE_BUSY", async () => {
    const rig = await filesRig();
    const uploading = (name: string, body: ReadableStream<Uint8Array>) =>
      rig.app.request(`/v1/leases/lse_1/files/${name}`, {
        body,
        duplex: "half",
        headers: agentAuth,
        method: "PUT",
      } as RequestInit);
    const text = async (response: Response) =>
      new TextDecoder().decode(await response.arrayBuffer());
    const bytes = new TextEncoder().encode("new");

    const cutFresh = liveBody();
    const cutting = uploading("fresh.bin", cutFresh.stream);
    await cutFresh.push(bytes);
    cutFresh.fail(new Error("socket hang up"));
    expect(await answered(cutting)).toBeDefined();
    expect(await folderEntries(rig.leaseFolder)).toEqual([]);

    expect((await rig.put("kept.bin", "old")).status).toBe(201);
    const cutKept = liveBody();
    const cuttingKept = uploading("kept.bin", cutKept.stream);
    await cutKept.push(bytes);
    cutKept.fail(new Error("socket hang up"));
    expect(await answered(cuttingKept)).toBeDefined();
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);
    expect(await text(await rig.get("kept.bin"))).toBe("old");

    const silent = liveBody();
    const silentRequest = uploading("kept.bin", silent.stream);
    await silent.push(bytes);
    rig.clock.advance(329_999);
    expect(await answered(silentRequest, 50)).toBeUndefined();
    rig.clock.advance(1);
    const stalled = await answered(silentRequest);
    expect(stalled?.status).toBe(408);
    expect(await stalled?.json()).toEqual({
      error: {
        code: "UPLOAD_STALLED",
        message: "No bytes of kept.bin arrived for 330 s",
        name: "kept.bin",
      },
    });
    expect(await folderEntries(rig.leaseFolder)).toEqual(["kept.bin"]);
    expect(await text(await rig.get("kept.bin"))).toBe("old");

    const mute = liveBody();
    const muteRequest = uploading("mute.bin", mute.stream);
    await mute.firstPull;
    rig.clock.advance(329_999);
    expect(await answered(muteRequest, 50)).toBeUndefined();
    rig.clock.advance(1);
    expect((await answered(muteRequest))?.status).toBe(408);

    const moving = liveBody();
    const movingRequest = uploading("moving.bin", moving.stream);
    for (const chunk of ["a", "b", "c"]) {
      await moving.push(new TextEncoder().encode(chunk));
      rig.clock.advance(200_000);
    }
    moving.finish();
    expect((await movingRequest).status).toBe(201);
    expect(await text(await rig.get("moving.bin"))).toBe("abc");

    for (const [firstName, secondName] of [
      ["x.bin", "x.bin"],
      ["A.tar", "a.tar"],
    ] as const) {
      const running = liveBody();
      const runningRequest = uploading(firstName, running.stream);
      await running.push(bytes);
      const refused = await rig.put(secondName, "other");
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: {
          code: "FILE_BUSY",
          message: `File ${secondName} is being uploaded by another request`,
          name: secondName,
        },
      });
      running.finish();
      expect((await runningRequest).status).toBe(201);
    }
  });

  it("a lease holder lists the lease's files and deletes one", async () => {
    const { leaseFolder, list, put, remove } = await filesRig();
    const files = async () => ((await (await list()).json()) as { files: unknown[] }).files;

    expect((await list()).status).toBe(200);
    expect(await files()).toEqual([]);

    expect((await put("b.txt", "bb")).status).toBe(201);
    expect((await put("a.txt", "a")).status).toBe(201);
    await mkdir(join(leaseFolder, "sub"));
    await writeFile(join(leaseFolder, "sub", "inner.txt"), "x");
    await writeFile(join(leaseFolder, "my file.png"), "x");
    expect(await files()).toEqual([
      { name: "a.txt", size: 1 },
      { name: "b.txt", size: 2 },
    ]);

    const removed = await remove("a.txt");
    expect(removed.status).toBe(204);
    expect(await files()).toEqual([{ name: "b.txt", size: 2 }]);

    const unknown = await remove("a.txt");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "UNKNOWN_FILE", message: "No file a.txt in this lease", name: "a.txt" },
    });
  });

  it("a lease holder's HEAD answers a GET's headers with no body and leaves no file open", async () => {
    const filesystem = new CountingFilesystem();
    const { app, put } = await filesRig({ filesystem });
    expect((await put("head.bin", "twelve bytes")).status).toBe(201);
    const head = await app.request("/v1/leases/lse_1/files/head.bin", {
      headers: agentAuth,
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("12");
    expect(await head.text()).toBe("");
    expect(filesystem.open).toBe(0);
  });

  it("a lease holder's file names match ignoring case", async () => {
    const { get, leaseFolder, list, put, remove } = await filesRig();
    const text = async (response: Response) =>
      new TextDecoder().decode(await response.arrayBuffer());
    const names = async () =>
      ((await (await list()).json()) as { files: { name: string }[] }).files.map(
        (file) => file.name,
      );

    expect((await put("A.tar", "upper")).status).toBe(201);
    expect(await text(await get("a.tar"))).toBe("upper");

    expect((await put("a.tar", "lower")).status).toBe(201);
    expect(await folderEntries(leaseFolder)).toEqual(["a.tar"]);
    expect(await names()).toEqual(["a.tar"]);
    expect(await text(await get("A.TAR"))).toBe("lower");

    expect((await remove("A.TAR")).status).toBe(204);
    expect(await names()).toEqual([]);

    await writeFile(join(leaseFolder, "A.tar"), "first");
    await writeFile(join(leaseFolder, "a.tar"), "second");
    if ((await folderEntries(leaseFolder)).length === 2) {
      expect(await text(await get("a.tar"))).toBe("second");
      expect(await text(await get("A.TAR"))).toBe("first");
      expect(await names()).toEqual(["A.tar", "a.tar"]);

      expect((await remove("a.tar")).status).toBe(204);
      expect(await names()).toEqual([]);
      expect(await folderEntries(leaseFolder)).toEqual([]);
      expect((await get("a.tar")).status).toBe(404);
      expect((await get("A.tar")).status).toBe(404);
    }
  });

  it("a lease holder GETs a file and gets it whole or the range it asked for", async () => {
    const { get, put } = await filesRig();
    const thousand = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);
    expect((await put("thousand.bin", thousand)).status).toBe(201);
    expect((await put("empty.bin", "")).status).toBe(201);
    const ranged = (name: string, range: string) => get(name, { ...agentAuth, range });
    const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

    const whole = await get("thousand.bin");
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(whole.headers)).toMatchObject({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": "1000",
      "content-type": "application/octet-stream",
      "simlock-content-length": "1000",
    });
    expect(await bytesOf(whole)).toEqual(thousand);

    const partial = [
      ["bytes=0-99", 0, 99],
      ["bytes=900-", 900, 999],
      ["bytes=-100", 900, 999],
      ["bytes=990-5000", 990, 999],
      ["bytes=-5000", 0, 999],
    ] as const;
    for (const [range, start, end] of partial) {
      const response = await ranged("thousand.bin", range);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/1000`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(response.headers.get("simlock-content-length")).toBe(String(end - start + 1));
      expect(await bytesOf(response)).toEqual(thousand.subarray(start, end + 1));
    }

    for (const [name, range] of [
      ["thousand.bin", "bytes=1000-"],
      ["thousand.bin", "bytes=-0"],
      ["empty.bin", "bytes=-5"],
    ] as const) {
      const response = await ranged(name, range);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(
        `bytes */${name === "empty.bin" ? 0 : 1000}`,
      );
    }

    for (const range of ["bytes=0-1,5-9", "bytes=9-5", "items=0-9", "bytes=abc", "bytes=-"]) {
      const response = await ranged("thousand.bin", range);
      expect(response.status).toBe(200);
      expect(await bytesOf(response)).toEqual(thousand);
    }

    const unknown = await get("missing.bin");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: {
        code: "UNKNOWN_FILE",
        message: "No file missing.bin in this lease",
        name: "missing.bin",
      },
    });
  });

  it("a caller that does not hold the lease gets 404 UNKNOWN_LEASE on every file route, and an operator is served", async () => {
    const { app, put, list, get } = await filesRig();
    expect((await put("mine.bin", "mine")).status).toBe(201);
    const routes = (leaseId: string, headers: Record<string, string>) => [
      () =>
        app.request(`/v1/leases/${leaseId}/files/mine.bin`, { body: "x", headers, method: "PUT" }),
      () => app.request(`/v1/leases/${leaseId}/files/mine.bin`, { headers }),
      () => app.request(`/v1/leases/${leaseId}/files`, { headers }),
      () => app.request(`/v1/leases/${leaseId}/files/mine.bin`, { headers, method: "DELETE" }),
    ];

    for (const [leaseId, headers] of [
      ["lse_1", otherAgentAuth],
      ["lse_unknown", agentAuth],
    ] as const) {
      for (const response of await Promise.all(routes(leaseId, headers).map((call) => call()))) {
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "UNKNOWN_LEASE",
        );
      }
    }
    expect(await (await list()).json()).toEqual({ files: [{ name: "mine.bin", size: 4 }] });
    expect(new TextDecoder().decode(await (await get("mine.bin")).arrayBuffer())).toBe("mine");

    const statuses: number[] = [];
    for (const call of routes("lse_1", operatorAuth)) statuses.push((await call()).status);
    expect(statuses).toEqual([201, 200, 200, 204]);
  });
});
