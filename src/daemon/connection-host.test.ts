import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FakeClock,
  IpcError,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryIpcTransport,
  MemoryLogSink,
  NodeFilesystem,
  type AccessEntry,
  type IpcConnection,
  type IpcConnector,
  type IpcListenerFactory,
} from "../ports/index.js";
import {
  DaemonAlreadyRunningError,
  DaemonEndpointHost,
  prepareDataDirectory,
} from "./connection-host.js";

const endpoint = "/simlock/daemon.sock";

const USER = "S-1-5-21-2160452881-2465010311-446649340-1001";
const FULL = 0x1f01ff;
const MODIFY = 0x1301bf;
const READ_EXECUTE = 0x1200a9;
// why: the masks are the ones `Get-Acl` returned on Windows 11 for the default home under
// `C:\Users\<user>` and for a new folder on `D:\`.
const OWNER_ONLY: readonly AccessEntry[] = [
  { sid: "S-1-5-18", name: "NT AUTHORITY\\SYSTEM", allow: true, rights: FULL },
  { sid: "S-1-5-32-544", name: "BUILTIN\\Administrators", allow: true, rights: FULL },
  { sid: USER, name: "DESKTOP\\Szymon", allow: true, rights: FULL },
  // why: `C:\Users\<user>` also grants an app capability traverse only, which reads nothing.
  {
    sid: "S-1-15-3-65536-3852923496",
    name: "S-1-15-3-65536-3852923496",
    allow: true,
    rights: 0x100020,
  },
];
const OTHER_DRIVE: readonly AccessEntry[] = [
  { sid: "S-1-5-32-544", name: "BUILTIN\\Administrators", allow: true, rights: FULL },
  { sid: "S-1-5-18", name: "NT AUTHORITY\\SYSTEM", allow: true, rights: FULL },
  { sid: "S-1-5-11", name: "NT AUTHORITY\\Authenticated Users", allow: true, rights: MODIFY },
  { sid: "S-1-5-32-545", name: "BUILTIN\\Users", allow: true, rights: READ_EXECUTE },
];
// why: quoted, since PowerShell reads an unquoted `(OI)` as a command; cmd.exe takes it too.
const icaclsFix = (path: string): string =>
  `icacls "${path}" /inheritance:r /grant:r "*${USER}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`;
const readable = (entries: readonly AccessEntry[]) => ({
  read: () => Promise.resolve({ user: USER, entries }),
});

describe("prepareDataDirectory", () => {
  it("on Windows warns from the folder's ACL only when another account can read or change it, names an icacls fix, and warns nothing when the ACL cannot be read; macOS and Linux keep the mode check", async () => {
    // why: Node reports 0o666 for every writable folder on Windows, whatever its ACL says.
    const cases = [
      { name: "default-home", platform: "win32", mode: 0o666, access: readable(OWNER_ONLY) },
      { name: "other-drive", platform: "win32", mode: 0o666, access: readable(OTHER_DRIVE) },
      {
        name: "read-only",
        platform: "win32",
        mode: 0o666,
        access: readable([
          ...OWNER_ONLY,
          { sid: "S-1-5-32-545", name: "BUILTIN\\Users", allow: true, rights: 0x1 },
        ]),
      },
      {
        name: "change-only",
        platform: "win32",
        mode: 0o666,
        access: readable([
          ...OWNER_ONLY,
          { sid: "S-1-5-21-1-2-3-1002", name: "DESKTOP\\Guest", allow: true, rights: 0x2 },
        ]),
      },
      {
        name: "generic-read",
        platform: "win32",
        mode: 0o666,
        access: readable([
          ...OWNER_ONLY,
          { sid: "S-1-5-21-1-2-3-1003", name: "DESKTOP\\Reader", allow: true, rights: 0x80000000 },
        ]),
      },
      {
        name: "denied",
        platform: "win32",
        mode: 0o666,
        access: readable([
          ...OWNER_ONLY,
          { sid: "S-1-5-32-545", name: "BUILTIN\\Users", allow: false, rights: FULL },
        ]),
      },
      {
        name: "creator-owner",
        platform: "win32",
        mode: 0o666,
        access: readable([
          ...OWNER_ONLY,
          { sid: "S-1-3-0", name: "CREATOR OWNER", allow: true, rights: FULL },
        ]),
      },
      {
        name: "unreadable",
        platform: "win32",
        mode: 0o666,
        access: { read: () => Promise.reject(new Error("powershell exited 1")) },
      },
      { name: "macos-open", platform: "darwin", mode: 0o755, access: readable(OWNER_ONLY) },
      { name: "linux-closed", platform: "linux", mode: 0o700, access: readable(OTHER_DRIVE) },
    ] as const;
    const warnings: [string, string | undefined][] = [];
    for (const testCase of cases) {
      const filesystem = new MemoryFilesystem();
      const path = `/home/${testCase.name}`;
      await filesystem.mkdirp(path);
      await filesystem.chmod(path, testCase.mode);
      const options = { platform: testCase.platform, directoryAccess: testCase.access };
      warnings.push([testCase.name, await prepareDataDirectory(filesystem, path, options)]);
    }

    expect(warnings).toEqual([
      ["default-home", undefined],
      [
        "other-drive",
        `data directory /home/other-drive is accessible to other users (NT AUTHORITY\\Authenticated Users, BUILTIN\\Users); run ${icaclsFix("/home/other-drive")}`,
      ],
      [
        "read-only",
        `data directory /home/read-only is accessible to other users (BUILTIN\\Users); run ${icaclsFix("/home/read-only")}`,
      ],
      [
        "change-only",
        `data directory /home/change-only is accessible to other users (DESKTOP\\Guest); run ${icaclsFix("/home/change-only")}`,
      ],
      [
        "generic-read",
        `data directory /home/generic-read is accessible to other users (DESKTOP\\Reader); run ${icaclsFix("/home/generic-read")}`,
      ],
      ["denied", undefined],
      ["creator-owner", undefined],
      ["unreadable", undefined],
      [
        "macos-open",
        "data directory /home/macos-open is accessible to other users (mode 755); run chmod 700 /home/macos-open",
      ],
      ["linux-closed", undefined],
    ]);
  });
});

describe("DaemonEndpointHost", () => {
  it("binds a fresh endpoint and removes only its owned entry on repeated stop", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    await filesystem.writeFileAtomic(endpoint, "owned");
    await filesystem.writeFileAtomic("/simlock/other.sock", "unrelated");
    await host.stop();
    await host.stop();
    expect(await filesystem.exists(endpoint)).toBe(false);
    expect(await filesystem.exists("/simlock/other.sock")).toBe(true);
    await expect(ipc.connect(endpoint)).rejects.toMatchObject({ code: "endpoint-not-found" });
  });

  it("creates the directory its endpoint lives in owner-only", async () => {
    // why: under the umask every real host starts from, a directory made without a mode comes
    // out 0755, so only a mode the host asks for ends at 0700.
    const previousUmask = process.umask(0o022);
    const base = await mkdtemp(join(tmpdir(), "simlock-endpoint-"));
    const ipc = new MemoryIpcTransport();
    const host = new DaemonEndpointHost({
      connector: ipc,
      endpoint: join(base, "home", "daemon.sock"),
      filesystem: new NodeFilesystem(),
      listenerFactory: ipc,
    });
    try {
      await host.start(() => undefined);

      expect((await stat(join(base, "home"))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      await host.stop();
      await rm(base, { force: true, recursive: true });
    }
  });

  it("rejects a live endpoint before binding", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "live");
    const ipc = new MemoryIpcTransport();
    const existing = await ipc.listen(endpoint, () => undefined);
    const listenerFactory: IpcListenerFactory = {
      listen: async () => {
        throw new Error("listener must not bind after a live probe");
      },
    };
    await expect(
      hostFor(filesystem, ipc, listenerFactory).start(() => undefined),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await existing.close();
  });

  it("maps bind races to an already-running error", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const racing: IpcListenerFactory = {
      listen: async () => {
        throw new IpcError("address-in-use", "race", undefined);
      },
    };
    await expect(hostFor(filesystem, ipc, racing).start(() => undefined)).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  it("claims a named pipe without touching the filesystem, which has nothing to make or remove", async () => {
    const pipe = String.raw`\\.\pipe\simlock-0123456789abcdef`;
    const untouchable = new Proxy(new MemoryFilesystem(), {
      get: (_target, method) => () => {
        throw new Error(`a pipe endpoint must not call filesystem.${String(method)}`);
      },
    });
    const ipc = new MemoryIpcTransport();
    const host = new DaemonEndpointHost({
      connector: ipc,
      endpoint: pipe,
      filesystem: untouchable,
      listenerFactory: ipc,
    });

    await host.start(() => undefined);
    await expect((await ipc.connect(pipe)).close()).resolves.toBeUndefined();
    await host.stop();

    await expect(ipc.connect(pipe)).rejects.toMatchObject({ code: "endpoint-not-found" });
  });

  it("refuses a second claim of a live named pipe", async () => {
    const pipe = String.raw`\\.\pipe\simlock-0123456789abcdef`;
    const ipc = new MemoryIpcTransport();
    const first = new DaemonEndpointHost({
      connector: ipc,
      endpoint: pipe,
      filesystem: new MemoryFilesystem(),
      listenerFactory: ipc,
    });
    await first.start(() => undefined);

    await expect(
      new DaemonEndpointHost({
        connector: ipc,
        endpoint: pipe,
        filesystem: new MemoryFilesystem(),
        listenerFactory: ipc,
      }).start(() => undefined),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await first.stop();
  });

  it("is one-shot after stopping", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    await host.stop();
    await expect(host.start(() => undefined)).rejects.toThrow("already been started");
  });

  it("propagates unknown probe failures", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "existing");
    const connector: IpcConnector = {
      connect: async (): Promise<IpcConnection> => {
        throw new IpcError("unknown", "denied", undefined);
      },
    };
    const ipc = new MemoryIpcTransport();
    await expect(hostFor(filesystem, connector, ipc).start(() => undefined)).rejects.toThrow(
      "denied",
    );
  });

  it("logs recovering a stale endpoint before claiming it", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "stale");
    const ipc = new MemoryIpcTransport();
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    const host = new DaemonEndpointHost({
      connector: ipc,
      endpoint,
      filesystem,
      listenerFactory: ipc,
      logger,
    });

    await host.start(() => undefined);

    expect(sink.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "Recovered stale daemon socket" }),
    );
    const claimedIndex = sink.records.findIndex(
      (record) => record.message === "Claimed daemon socket",
    );
    const recoveredIndex = sink.records.findIndex(
      (record) => record.message === "Recovered stale daemon socket",
    );
    expect(recoveredIndex).toBeLessThan(claimedIndex);
    await host.stop();
  });
});

function hostFor(
  filesystem: MemoryFilesystem,
  connector: IpcConnector,
  listenerFactory: IpcListenerFactory,
): DaemonEndpointHost {
  return new DaemonEndpointHost({ connector, endpoint, filesystem, listenerFactory });
}
