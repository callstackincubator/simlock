import { describe, expect, it } from "vitest";
import { SimlockError, type StatusGetOutput } from "../client/index.js";
import { FakeSimlockClient, sampleGrant, startingStatus } from "./test-support.js";
import { call, connectedServer, text } from "./test-server.js";

type StatusDevice = NonNullable<StatusGetOutput["devices"]>[number];
type WorkerView = NonNullable<StatusGetOutput["workers"]>[number];

describe("MCP list_devices physicalDevices", () => {
  const phone = {
    physical: true,
    platform: "ios",
    model: "iPhone 15",
    osVersion: "26.4",
    class: "phone",
  } as const;
  const listed = {
    platform: "ios",
    model: "iPhone 15",
    osVersion: "26.4",
    class: "phone",
  } as const;
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly devices: StatusDevice[] | undefined;
    readonly workers?: WorkerView[];
    readonly expected: unknown[];
  }> = [
    {
      name: "a ready phone",
      devices: [statusDevice({ ...phone, id: "p1", state: "ready" })],
      expected: [{ ...listed, state: "ready" }],
    },
    {
      name: "a phone through a gateway, with its worker",
      devices: [statusDevice({ ...phone, id: "p1", state: "ready", workerId: "mac-mini-2" })],
      workers: [workerView("mac-mini-2", {})],
      expected: [{ ...listed, workerId: "mac-mini-2", state: "ready" }],
    },
    {
      name: "phones on a lost, an incompatible and a drained worker are left out",
      devices: [
        statusDevice({ ...phone, id: "p1", state: "ready", workerId: "lost" }),
        statusDevice({ ...phone, id: "p2", state: "ready", workerId: "old" }),
        statusDevice({ ...phone, id: "p3", state: "ready", workerId: "drained" }),
        statusDevice({ ...phone, id: "p4", model: "iPhone 16", state: "ready", workerId: "ok" }),
      ],
      workers: [
        workerView("lost", { connection: "disconnected" }),
        workerView("old", { connection: "incompatible" }),
        workerView("drained", { drained: true }),
        workerView("ok", {}),
      ],
      expected: [{ ...listed, model: "iPhone 16", workerId: "ok", state: "ready" }],
    },
    {
      name: "simulators and emulators are left out",
      devices: [
        statusDevice({
          id: "s1",
          physical: false,
          platform: "ios",
          model: "iPhone 17",
          osVersion: "26.5",
          state: "ready",
        }),
        statusDevice({
          id: "e1",
          physical: false,
          platform: "android",
          model: "Pixel 8",
          osVersion: "35",
          state: "leased",
        }),
      ],
      expected: [],
    },
    { name: "no phone enrolled", devices: [], expected: [] },
    { name: "a daemon still starting, with no device list", devices: undefined, expected: [] },
    {
      name: "a removed phone is left out",
      devices: [
        statusDevice({ ...phone, id: "p1", state: "deleted" }),
        statusDevice({ ...phone, id: "p2", model: "iPhone 16", state: "ready" }),
      ],
      expected: [{ ...listed, model: "iPhone 16", state: "ready" }],
    },
    {
      name: "a leased phone, with no holder field",
      devices: [statusDevice({ ...phone, id: "p1", state: "leased" })],
      expected: [{ ...listed, state: "leased" }],
    },
    ...(["locked", "untrusted", "not-present"] as const).map((absentReason) => ({
      name: `an absent phone, reason ${absentReason}`,
      devices: [statusDevice({ ...phone, id: "p1", state: "absent", absentReason })],
      expected: [{ ...listed, state: "absent", absentReason }],
    })),
  ];

  it("lists the catalog plus each enrolled phone's worker, platform, model, OS version, class, state and absent reason, and no holder", async () => {
    for (const { name, devices, workers, expected } of cases) {
      const client = new FakeSimlockClient();
      client.getCatalogImpl = () => Promise.resolve({ platforms: [] });
      client.getStatusImpl = () => Promise.resolve(statusOutput(devices, workers));
      const { mcpClient, close } = await connectedServer(client);
      try {
        const result = await call(mcpClient, "list_devices", {});
        expect(result.isError, name).not.toBe(true);
        expect(result.structuredContent, name).toEqual({
          platforms: [],
          physicalDevices: expected,
        });
      } finally {
        await close();
      }
    }

    const failing = new FakeSimlockClient();
    failing.getCatalogImpl = () => Promise.resolve({ platforms: [] });
    failing.getStatusImpl = () =>
      Promise.reject(new SimlockError("FORBIDDEN", "protocol", "not allowed", {}));
    const { mcpClient, close } = await connectedServer(failing);
    try {
      const result = await call(mcpClient, "list_devices", {});
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result))).toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await close();
    }
  });
});

describe("MCP rotate_device", () => {
  it("rotates the session's held lease and returns its id and the canonical orientation", async () => {
    const client = new FakeSimlockClient();
    client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
    client.rotateImpl = (leaseId, orientation) => Promise.resolve({ leaseId, orientation });
    client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
    const { mcpClient, close } = await connectedServer(client);
    try {
      const never = await call(mcpClient, "rotate_device", { orientation: "left" });
      expect(never.isError).toBe(true);
      expect(JSON.parse(text(never)).code).toBe("NO_LEASE");
      await call(mcpClient, "lease_simulator", { model: "iPhone 17 Pro", platform: "ios" });
      const result = await call(mcpClient, "rotate_device", { orientation: "landscape-left" });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        leaseId: "lease-1",
        orientation: "landscape_left",
      });
      expect(client.calls.filter((entry) => entry.method === "rotate")).toEqual([
        { input: { leaseId: "lease-1", orientation: "landscape_left" }, method: "rotate" },
      ]);

      for (const [spelling, canonical] of [
        ["LEFT", "landscape_left"],
        [" upside-down ", "portrait_upside_down"],
      ]) {
        const spelled = await call(mcpClient, "rotate_device", { orientation: spelling });
        expect(spelled.isError).not.toBe(true);
        expect(spelled.structuredContent).toEqual({ leaseId: "lease-1", orientation: canonical });
      }
      for (const [orientation, bound] of [
        ["", "expected string to have >=1 characters"],
        ["x".repeat(65), "expected string to have <=64 characters"],
      ] as const) {
        const refused = await call(mcpClient, "rotate_device", { orientation });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain(`Invalid arguments for tool rotate_device: Too `);
        expect(text(refused)).toContain(bound);
      }
      const longest = await call(mcpClient, "rotate_device", { orientation: "x".repeat(64) });
      expect(JSON.parse(text(longest)).code).toBe("BAD_REQUEST");
      expect(client.calls.filter((entry) => entry.method === "rotate")).toHaveLength(3);
      const unknown = await call(mcpClient, "rotate_device", { orientation: "sideways" });
      expect(unknown.isError).toBe(true);
      expect(JSON.parse(text(unknown))).toEqual({
        code: "BAD_REQUEST",
        message:
          "Unknown orientation sideways; use portrait, portrait-upside-down, landscape-left or landscape-right",
      });
      const unsupported = new SimlockError(
        "ROTATION_UNSUPPORTED",
        "domain",
        "Lease lease-1 is on an Android emulator; only an iOS simulator can be rotated",
        { class: "emulator", leaseId: "lease-1", physical: false, platform: "android" },
      );
      client.rotateImpl = () => Promise.reject(unsupported);
      const refusal = await call(mcpClient, "rotate_device", { orientation: "left" });
      expect(refusal.isError).toBe(true);
      expect(JSON.parse(text(refusal))).toEqual({
        code: "ROTATION_UNSUPPORTED",
        message: unsupported.message,
      });
      client.rotateImpl = (leaseId, orientation) => Promise.resolve({ leaseId, orientation });

      await call(mcpClient, "release_simulator", { leaseId: "lease-1" });
      const released = await call(mcpClient, "rotate_device", { orientation: "left" });
      expect(released.isError).toBe(true);
      expect(JSON.parse(text(released))).toEqual({
        code: "NO_LEASE",
        message: "This MCP session holds no lease. Call lease_simulator first.",
      });
    } finally {
      await close();
    }
  });
});

interface StatusDeviceFixture {
  readonly id: string;
  readonly physical: boolean;
  readonly platform: "ios" | "android";
  readonly model: string;
  readonly osVersion: string;
  readonly class?: "phone" | "tablet";
  readonly state: StatusDevice["state"];
  readonly absentReason?: StatusDevice["absentReason"];
  readonly workerId?: string;
}

function statusDevice(fixture: StatusDeviceFixture): StatusDevice {
  return {
    id: fixture.id,
    spec: {
      physical: fixture.physical,
      platform: fixture.platform,
      model: fixture.model,
      osVersion: fixture.osVersion,
    },
    state: fixture.state,
    physical: fixture.physical,
    servesDefaultMode: false,
    ...(fixture.class === undefined ? {} : { class: fixture.class }),
    ...(fixture.absentReason === undefined ? {} : { absentReason: fixture.absentReason }),
    ...(fixture.workerId === undefined ? {} : { workerId: fixture.workerId }),
  };
}

function statusOutput(
  devices: StatusDevice[] | undefined,
  workers?: WorkerView[],
): StatusGetOutput {
  return {
    ...startingStatus(),
    ...(devices === undefined ? {} : { devices }),
    ...(workers === undefined ? {} : { workers }),
  };
}

function workerView(
  id: string,
  state: { readonly connection?: WorkerView["connection"]; readonly drained?: boolean },
): WorkerView {
  return {
    id,
    connection: state.connection ?? "connected",
    drained: state.drained ?? false,
    lastSeenAt: 0,
  };
}
