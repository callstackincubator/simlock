import { describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { tokenIdentity } from "../auth/testing.js";
import type { HttpDispatch } from "../http/dispatcher-session.js";
import { FakeClock, NoopLogger } from "../ports/index.js";
import { FrontMap } from "./front/front-map.js";
import { createFront } from "./front/front.js";
import { RelayHostLink, type FleetPort } from "./front/relay-host-link.js";
import { Renewals } from "./front/renewals.js";
import {
  phoneSerial,
  setUpWithPhone,
  advance,
  listed,
  tapDispatch,
  simlockPicks,
  idOf,
  batch,
  release,
} from "./test-edge.js";
import {
  secrets,
  principals,
  notAvailable,
  adminSession,
  sessionFor,
  type Rig,
  iosDriver,
  androidDriver,
  setUp,
  send,
  rpc,
  bodyOf,
  envelopeOf,
  hex,
  allocate,
  granted,
  requestedSpecs,
  refusal,
  runCommand,
  forwarded,
  refused,
} from "./test-support.js";

// why: Fallow reads a `rig` binding's type only from an annotation in this file, not from an imported
// setUp's return type, so a `rig` whose test calls a FakeAgentDevice member only these tests use is
// annotated `Rig`; without it Fallow reports the member as never referenced.

const onlyIosAndAndroid = "refused: only iOS and Android";
const uploadOnly = "refused: send the app from your machine as an upload";
const noDeviceLeased = "refused: no device leased; run open first";
const deviceSetRefusal =
  "refused: simlock chooses the device set; run disconnect, then connect proxy without --ios-simulator-device-set";
const allowlistRefusal =
  "refused: simlock chooses the devices; run disconnect, then connect proxy without --android-device-allowlist";

const bothDrivers = (clock: FakeClock): FakeDriver[] => [iosDriver(clock), androidDriver(clock)];

// why: the fake agent-device names the device it leases `simlock-<id>`, as the real one does.
function nameOf(rig: Rig, n: number): string {
  return `simlock-${idOf(rig, n)}`;
}

function commandsReceived(rig: Rig) {
  return rig.fake.rpcRequests("agent_device.command");
}

function flagsOf(params: Record<string, unknown>): Record<string, unknown> {
  return (params["flags"] ?? {}) as Record<string, unknown>;
}

// why: the decomposed front's gateway adoption is exercised at its HTTP mount with a fake fleet view.
describe("the agent-device front's request rules", () => {
  describe("rule 1, the route", () => {
    it.each([
      ["GET", "/health"],
      ["POST", "/upload"],
      ["POST", "/upload/preflight"],
      ["POST", "/upload/finalize"],
      ["PUT", "/upload/direct/ticket-1"],
      ["GET", "/artifacts"],
      ["GET", "/artifacts/"],
      ["GET", "/artifacts/a.png"],
      ["GET", "/artifacts/dir/a.png"],
      ["GET", "/sessions/tok_one:s1/requests/r1/diagnostics"],
    ])("%s %s with a token reaches agent-device", async (method, path) => {
      const rig = await setUp();

      const answer = await send(rig, path, { method, ...(method === "GET" ? {} : { body: "{}" }) });

      await answer.text();
      expect(rig.fake.requests.map((request) => request.path)).toEqual([path]);
    });

    it.each([
      ["GET", "/admin/leases"],
      ["POST", "/health"],
      ["POST", "/rpcx"],
      ["POST", "/rpc/x"],
      ["PUT", "/upload/direct/a/b"],
      ["GET", "/sessions/s1/requests/r1/diagnostics/extra"],
    ])("%s %s is refused 404 and reaches nothing", async (method, path) => {
      const rig = await setUp();
      await (await send(rig, "/health")).text();
      const before = rig.fake.requests.length;

      const answer = await send(rig, path, { method, ...(method === "GET" ? {} : { body: "{}" }) });

      expect(answer.status).toBe(404);
      expect(await bodyOf(answer)).toEqual({
        code: "INVALID_ARGS",
        error: `refused: unknown route ${method} ${path}`,
        ok: false,
        reason: "REFUSED_BY_SIMLOCK",
        retriable: false,
      });
      expect(rig.fake.requests.length).toBe(before);
    });

    it("a route outside the list answers 401 without a token, and `agent-device is not available on this simlock` while agent-device is unavailable", async () => {
      const rig = await setUp();
      expect((await send(rig, "/admin/leases")).status).toBe(404);
      const missing = await send(rig, "/admin/leases", { token: null });
      expect(missing.status).toBe(401);
      rig.fake.setUnavailable("found 0.20.3, need 0.21.28 or later");

      const unavailable = await send(rig, "/admin/leases");

      expect(await unavailable.text()).toContain(`${notAvailable}found 0.20.3`);
      expect(rig.fake.requests).toEqual([]);
    });
  });

  describe("rule 2, the RPC method", () => {
    it("an unknown RPC method is refused, and `agent-device.command` with a dash is forwarded", async () => {
      const rig = await setUp();
      await forwarded(rig, () => rpc(rig, "agent-device.command", { command: "snapshot" }));

      await refused(
        rig,
        () => rpc(rig, "agent_device.admin", { command: "snapshot" }),
        "refused: unknown method agent_device.admin",
      );
    });

    it("`install_from_source` and `release_materialized_paths`, which agent-device's proxy refuses for a tenant, are refused `refused: unknown method <method>` and never forwarded", async () => {
      const rig = await setUp();

      await refused(
        rig,
        () =>
          rpc(rig, "agent_device.install_from_source", {
            platform: "ios",
            source: { kind: "url", url: "https://example.com/App.zip" },
          }),
        "refused: unknown method agent_device.install_from_source",
      );
      await refused(
        rig,
        () => rpc(rig, "agent_device.release_materialized_paths", { materializationId: "m-1" }),
        "refused: unknown method agent_device.release_materialized_paths",
      );
    });
  });

  describe("rule 4, the platform", () => {
    it("a command with `--platform android` is forwarded; with `macos` or `apple`, or `runtime.platform` `harmonyos`, it is refused", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { flags: { platform: "android" } }),
      );

      for (const platform of ["macos", "apple"]) {
        await refused(
          rig,
          () => runCommand(rig, "snapshot", undefined, { flags: { platform } }),
          onlyIosAndAndroid,
        );
      }
      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { runtime: { platform: "harmonyos" } }),
        onlyIosAndAndroid,
      );
    });

    it("a command with `--platform ios` while the iOS driver is off is refused with `refused: ios is not available on this simlock`", async () => {
      const rig = await setUp({ drivers: (clock) => [androidDriver(clock)] });
      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { flags: { platform: "android" } }),
      );

      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { flags: { platform: "ios" } }),
        "refused: ios is not available on this simlock",
      );
    });

    it.each([
      ["runtime.platform", (platform: string) => ({ runtime: { platform } })],
      ["flags.platform", (platform: string) => ({ flags: { platform } })],
    ] as const)(
      "a batch step whose `%s` is `web` is refused and no step after the accepted one reaches agent-device",
      async (_field, place) => {
        const rig = await setUp();
        const steps = [{ command: "snapshot", ...place("ios") }];
        await forwarded(rig, () => batch(rig, undefined, steps));

        await refused(
          rig,
          () => batch(rig, undefined, [...steps, { command: "snapshot", ...place("web") }]),
          onlyIosAndAndroid,
        );
        expect(commandsReceived(rig)).toHaveLength(1);
      },
    );
  });

  describe("batch caps", () => {
    const leaf = { command: "snapshot" };
    const nest = (levels: number, leaves = 1): Record<string, unknown>[] => {
      let steps: Record<string, unknown>[] = Array.from({ length: leaves }, () => leaf);
      for (let level = 1; level < levels; level += 1) {
        steps = [{ command: "batch", flags: { batchSteps: steps } }];
      }
      return steps;
    };

    it("a batch nested deeper than 8 levels or with more than 1000 steps is refused before any step reaches agent-device, and flattening copies each step a bounded number of times", async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, nest(8)));
      await forwarded(rig, () => batch(rig, undefined, nest(1, 1000)));

      await refused(
        rig,
        () => batch(rig, undefined, nest(9)),
        "refused: a batch nests more than 8 levels deep",
      );
      await refused(
        rig,
        () => batch(rig, undefined, nest(1, 1001)),
        "refused: a batch has more than 1000 steps",
      );
      await refused(
        rig,
        () => batch(rig, undefined, nest(2, 1000)),
        "refused: a batch has more than 1000 steps",
      );

      const original = Array.prototype.flatMap;
      let copied = 0;
      const spy = vi.spyOn(Array.prototype, "flatMap").mockImplementation(function (
        this: unknown[],
        ...args: Parameters<typeof original>
      ) {
        const result = original.apply(this, args) as unknown[];
        copied += result.length;
        return result;
      });
      try {
        await forwarded(rig, () => batch(rig, undefined, nest(8, 500)));
      } finally {
        spy.mockRestore();
      }
      expect(copied).toBeLessThanOrEqual(2 * 507);
    });
  });

  describe("rule 6, device selectors", () => {
    it("`udid` and `serial` of the agent's own leased device are forwarded; another device's are refused, in `flags` and in `input` alike", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1);
      await granted(rig, 2, { device: "Pixel 8", platform: "android" });
      await granted(rig, 3, {}, { token: secrets.two });
      const own = idOf(rig, 1);
      const ownSerial = idOf(rig, 2);
      const other = idOf(rig, 3);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: own } }));
      await forwarded(rig, () => runCommand(rig, "snapshot", 2, { flags: { serial: ownSerial } }));
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { input: { udid: own } }));

      const attempts: [number, Record<string, unknown>][] = [
        [1, { flags: { udid: other } }],
        [1, { input: { udid: other } }],
        [2, { flags: { serial: other } }],
        [2, { input: { serial: other } }],
      ];
      for (const [lease, fields] of attempts) {
        await refused(rig, () => runCommand(rig, "snapshot", lease, fields), simlockPicks);
      }
    });

    it("on a phone lease the phone's own serial is forwarded to the phone daemon; another `serial` or `udid` is refused with `refused: simlock picks the device`", async () => {
      const rig = await setUpWithPhone();
      await granted(rig, 1, { physical: true, platform: "android" });
      const reached = () => rig.phone.rpcRequests("agent_device.command").length;
      await runCommand(rig, "snapshot", 1, { flags: { serial: phoneSerial } });
      expect(reached()).toBe(1);

      for (const flags of [{ serial: "emulator-5554" }, { udid: "00008030-000270803C28802E" }]) {
        const answer = await envelopeOf(await runCommand(rig, "snapshot", 1, { flags }));

        expect(answer.error).toMatchObject(refusal(simlockPicks));
      }
      expect(reached()).toBe(1);
    });

    it("`--device` with the leased device's id, and its name with `_` for a space, extra spaces and other letter case, are forwarded unchanged", async () => {
      const rig: Rig = await setUp();
      rig.fake.nameDeviceInNextReply({ name: "Sim Lock Phone" });
      await granted(rig, 1);
      const own = idOf(rig, 1);

      for (const device of [own, "Sim Lock Phone", "sim_lock_phone", "  SIM   lock  phone "]) {
        const params = await forwarded(rig, () =>
          runCommand(rig, "snapshot", 1, { flags: { device } }),
        );
        expect(flagsOf(params)["device"]).toBe(device);
      }
    });

    it("`--device` with the leased device's own name is forwarded as sent; with the leased model, or a catalog alias of it, it reaches agent-device as `udid` of the leased device on iOS and `serial` on Android, with no `device`; another model is refused", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1, { device: "iPhone 17 Pro" });
      await granted(rig, 2, { device: "Pixel 8", platform: "android" });
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 1) } }));
      const byName = await forwarded(rig, () =>
        runCommand(rig, "snapshot", 1, { flags: { device: nameOf(rig, 1) } }),
      );

      const ios = flagsOf(
        await forwarded(rig, () =>
          runCommand(rig, "snapshot", 1, { flags: { device: "iphone 17 pro" } }),
        ),
      );
      const android = flagsOf(
        await forwarded(rig, () => runCommand(rig, "snapshot", 2, { flags: { device: "p8" } })),
      );

      expect(flagsOf(byName)["device"]).toBe(nameOf(rig, 1));
      expect(ios["udid"]).toBe(idOf(rig, 1));
      expect(ios).not.toHaveProperty("device");
      expect(android["serial"]).toBe(idOf(rig, 2));
      expect(android).not.toHaveProperty("device");
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { device: "iPhone 16" } }),
        simlockPicks,
      );
    });

    it("a command with `osVersion` or `imageTag` on `flags`, on `input` or inside a batch step reaches agent-device without them, and a command without them reaches it with its flags as sent", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const keys = { imageTag: "default", osVersion: ">=26" };

      const onFlags = await forwarded(rig, () =>
        runCommand(rig, "snapshot", 1, { flags: { ...keys, platform: "ios" } }),
      );
      const onInput = await forwarded(rig, () =>
        runCommand(rig, "snapshot", 1, { input: { ...keys, platform: "ios" } }),
      );
      const inStep = await forwarded(rig, () =>
        batch(rig, 1, [{ command: "snapshot", flags: { ...keys, platform: "ios" } }]),
      );
      const plain = await forwarded(rig, () =>
        runCommand(rig, "snapshot", 1, { flags: { platform: "ios" } }),
      );

      expect(flagsOf(onFlags)).toEqual({ platform: "ios" });
      expect(onInput["input"]).toEqual({ platform: "ios" });
      const steps = flagsOf(inStep)["batchSteps"] as { flags: Record<string, unknown> }[];
      expect(steps[0]?.flags).toEqual({ platform: "ios" });
      expect(flagsOf(plain)).toEqual({ platform: "ios" });
    });

    it("`--device` with the leased model in `input` is removed from `input` and sent as `flags.udid`", async () => {
      const rig = await setUp();
      await granted(rig, 1, { device: "iPhone 17 Pro" });

      const params = await forwarded(rig, () =>
        runCommand(rig, "snapshot", 1, { input: { device: "iPhone 17 Pro" } }),
      );

      expect(flagsOf(params)["udid"]).toBe(idOf(rig, 1));
      expect(params["input"] ?? {}).not.toHaveProperty("device");
    });

    it("`test --device <own udid>,<own name>` is forwarded; for an agent holding two devices, `test --device \"<udid A>, ,<udid B>,\"` is forwarded; a list with an entry naming another token's device, or the leased device's model, is refused", async () => {
      const rig: Rig = await setUp();
      rig.fake.nameDeviceInNextReply({ name: "Sim Lock Phone" });
      await granted(rig, 1, { device: "iPhone 17 Pro" });
      await granted(rig, 2);
      await granted(rig, 3, {}, { token: secrets.two });
      const [a, b, other] = [idOf(rig, 1), idOf(rig, 2), idOf(rig, 3)];
      const test = (device: string) => runCommand(rig, "test", 1, { flags: { device } });
      await forwarded(rig, () => test(`${a},Sim Lock Phone`));
      await forwarded(rig, () => test(` ${a}, ,${b},`));

      await refused(rig, () => test(`${a},${other}`), simlockPicks);
      await refused(rig, () => test(`${a},iPhone 17 Pro`), simlockPicks);
    });

    it("`test --device <own udid>` with no lease named is forwarded; naming the device of the token's own ended lease it is refused", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      await granted(rig, 2, { ttlMs: 600_000 });
      const [ended, alive] = [idOf(rig, 1), idOf(rig, 2)];
      await forwarded(rig, () => runCommand(rig, "test", undefined, { flags: { device: ended } }));
      await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, sessionFor(principals.one));
      await expect.poll(() => listed(rig)).toEqual([hex(2)]);

      await forwarded(rig, () => runCommand(rig, "test", undefined, { flags: { device: alive } }));
      await refused(
        rig,
        () => runCommand(rig, "test", undefined, { flags: { device: ended } }),
        simlockPicks,
      );
    });

    it("with no lease named, a command with `udid`, one with `serial` and one with `device` are each refused", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 1) } }));

      for (const flags of [
        { udid: idOf(rig, 1) },
        { serial: "emulator-5554" },
        { device: "iPhone 16" },
      ]) {
        await refused(rig, () => runCommand(rig, "snapshot", undefined, { flags }), simlockPicks);
      }
    });

    it("with no lease named and no selector, a command reaches agent-device unchanged", async () => {
      const rig = await setUp();
      const fields = { flags: { session: "main" }, positionals: ["a"] };

      const params = await forwarded(rig, () => runCommand(rig, "snapshot", undefined, fields));

      expect(params).toMatchObject({ command: "snapshot", ...fields });
      expect(Object.keys(flagsOf(params))).toEqual(["session"]);
    });

    it("a command naming its lease only in `flags.leaseId`, with its own udid, is forwarded", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const own = idOf(rig, 1);
      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { flags: { udid: own } }),
        simlockPicks,
      );

      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { flags: { leaseId: hex(1), udid: own } }),
      );
    });

    it("a command naming agent B's lease with that lease's udid is refused; an agent holding two devices is refused lease B's udid on a command for lease A", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await granted(rig, 2);
      await granted(rig, 3, {}, { token: secrets.two });
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 1) } }));

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 3, { flags: { udid: idOf(rig, 3) } }),
        simlockPicks,
      );
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { udid: idOf(rig, 2) } }),
        simlockPicks,
      );
    });

    it("a command naming its lease with that lease's `deviceKey` is forwarded; with another lease's `deviceKey`, in `meta` or only in `flags`, it is refused; with no lease named, a stale `deviceKey` is forwarded", async () => {
      const rig: Rig = await setUp();
      rig.fake.nameDeviceKeyInNextReply("key-1");
      await granted(rig, 1);
      rig.fake.nameDeviceKeyInNextReply("key-2");
      await granted(rig, 2);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "key-1" } }));

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: "key-2" } }),
        simlockPicks,
      );
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { deviceKey: "key-2" } }),
        simlockPicks,
      );
      await forwarded(rig, () =>
        runCommand(rig, "snapshot", undefined, { meta: { deviceKey: "key-2" } }),
      );
    });

    it("a batch step with another device's udid is refused and no step reaches agent-device", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await granted(rig, 2, {}, { token: secrets.two });
      const steps = [{ command: "snapshot", flags: { udid: idOf(rig, 1) } }];
      await forwarded(rig, () => batch(rig, 1, steps));

      await refused(
        rig,
        () => batch(rig, 1, [...steps, { command: "snapshot", flags: { udid: idOf(rig, 2) } }]),
        simlockPicks,
      );
      expect(commandsReceived(rig)).toHaveLength(1);
    });

    it("in a batch, a step with the leased model reaches agent-device with the leased id, a sharded `test` step is filled as rule 7 says, and a step naming another lease is refused", async () => {
      const rig = await setUp();
      await granted(rig, 1, { device: "iPhone 17 Pro" });
      await granted(rig, 2, {}, { token: secrets.two });

      const params = await forwarded(rig, () =>
        batch(rig, 1, [
          { command: "snapshot", flags: { device: "iPhone 17 Pro" } },
          { command: "test", flags: { shardAll: 2 } },
        ]),
      );

      const steps = flagsOf(params)["batchSteps"] as { flags: Record<string, unknown> }[];
      expect(steps[0]?.flags["udid"]).toBe(idOf(rig, 1));
      expect(steps[0]?.flags).not.toHaveProperty("device");
      expect(steps[1]?.flags["device"]).toBe(nameOf(rig, 1));
      await refused(
        rig,
        () => batch(rig, 1, [{ command: "snapshot", flags: { leaseId: hex(2) } }]),
        "refused: a batch step cannot name another lease",
      );
    });

    it("a `udid` that is a number is refused with `refused: malformed udid`; a `shardAll` that is a string with `refused: malformed shardAll`; on an allocate an `osVersion` that is a number is refused with `refused: malformed osVersion` an `imageTag` that is an object with `refused: malformed imageTag` and a `physical` of `yes` or `1` with `refused: malformed physical` and no lease, as is an `osVersion` number on a command's flags, while `osVersion: null` is absent", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "test", 1, { flags: { shardAll: 2 } }));

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { udid: 12 } }),
        "refused: malformed udid",
      );
      await refused(
        rig,
        () => runCommand(rig, "test", 1, { flags: { shardAll: "2" } }),
        "refused: malformed shardAll",
      );
      await refused(rig, () => allocate(rig, 2, { osVersion: 26 }), "refused: malformed osVersion");
      await refused(rig, () => allocate(rig, 2, { imageTag: {} }), "refused: malformed imageTag");
      for (const physical of ["yes", 1]) {
        await refused(rig, () => allocate(rig, 2, { physical }), "refused: malformed physical");
      }
      expect(await listed(rig)).toEqual([hex(1)]);
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { osVersion: 26 } }),
        "refused: malformed osVersion",
      );
      await granted(rig, 3, { osVersion: null });
      expect(await requestedSpecs(rig, hex(3))).toEqual([{ platform: "ios" }]);
    });

    it("after simlock ended the lease, a command with that lease's udid is forwarded and agent-device's answer reaches the CLI; one TTL later the same command is refused with `refused: simlock picks the device`", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      const own = idOf(rig, 1);
      await rig.daemon.dispatch("lease.release-all", {}, adminSession);
      await expect.poll(() => listed(rig)).toEqual([]);

      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: { udid: own } }));
      await advance(rig, 61_000, 5_000);

      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { flags: { udid: own } }),
        simlockPicks,
      );
    });
  });

  describe("rule 5, device set and allowlist", () => {
    it("`--ios-simulator-device-set` naming any directory is refused with the disconnect-and-reconnect message, on a command and on an allocate", async () => {
      const rig = await setUp();
      await forwarded(rig, () => runCommand(rig, "snapshot", undefined));
      const set = "/var/simlock/devices";

      await refused(
        rig,
        () => runCommand(rig, "snapshot", undefined, { flags: { iosSimulatorDeviceSet: set } }),
        deviceSetRefusal,
      );
      await refused(rig, () => allocate(rig, 1, { iosSimulatorDeviceSet: set }), deviceSetRefusal);
      expect(await requestedSpecs(rig, principals.one)).toEqual([]);
    });

    it("`--android-device-allowlist` is refused with its disconnect-and-reconnect message, on a command and in a batch step", async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      await refused(
        rig,
        () =>
          runCommand(rig, "snapshot", undefined, {
            flags: { androidDeviceAllowlist: "emulator-5554" },
          }),
        allowlistRefusal,
      );
      await refused(
        rig,
        () =>
          batch(rig, undefined, [
            { command: "snapshot", flags: { androidDeviceAllowlist: "emulator-5554" } },
          ]),
        allowlistRefusal,
      );
    });
  });

  describe("rule 7, sharding", () => {
    const shard = (
      rig: Rig,
      n: number | undefined,
      flags: Record<string, unknown> = {},
      token: string = secrets.one,
    ) => runCommand(rig, "test", n, { flags: { shardAll: 2, ...flags } }, { token });

    it("`test --shard-all 2` with no `--device` reaches agent-device with `device` set to the token's leased devices, for an agent holding one device and one holding two, while another token's leased device is left out", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await granted(rig, 2, {}, { token: secrets.two });
      await granted(rig, 3, {}, { token: secrets.two });

      const one = await forwarded(rig, () => shard(rig, 1));
      const two = await forwarded(rig, () => shard(rig, 2, {}, secrets.two));

      expect(flagsOf(one)["device"]).toBe(nameOf(rig, 1));
      expect(String(flagsOf(two)["device"]).split(",").sort()).toEqual(
        [nameOf(rig, 2), nameOf(rig, 3)].sort(),
      );
    });

    it("`test --platform ios --shard-all 1` gets only the simulator's id, `--target tv` only the TV's id (a device whose reply named no target counts as `mobile`), and `--platform android` from a token holding only the simulator is refused", async () => {
      const rig: Rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1);
      await granted(rig, 2, { device: "Pixel 8", platform: "android" });
      rig.fake.nameDeviceInNextReply({ target: "tv" });
      await granted(rig, 3, { device: "Apple TV 4K", target: "tv" });

      const ios = await forwarded(rig, () =>
        shard(rig, 1, { platform: "ios", shardAll: 1, target: "mobile" }),
      );
      const tv = await forwarded(rig, () => shard(rig, 1, { shardAll: 1, target: "tv" }));
      const android = await forwarded(rig, () =>
        shard(rig, 2, { platform: "android", shardAll: 1 }),
      );

      expect(flagsOf(ios)["device"]).toBe(nameOf(rig, 1));
      expect(flagsOf(tv)["device"]).toBe(nameOf(rig, 3));
      expect(flagsOf(android)["device"]).toBe(nameOf(rig, 2));
      const iosOnly = await setUp({ drivers: bothDrivers });
      await granted(iosOnly, 1);
      await forwarded(iosOnly, () => shard(iosOnly, 1, { platform: "ios", shardAll: 1 }));
      await refused(
        iosOnly,
        () => shard(iosOnly, 1, { platform: "android", shardAll: 1 }),
        noDeviceLeased,
      );
    });

    it("`test --shard-all 2` names a device by the name agent-device gave it, and by its id when that name holds a comma or neither the reply nor the inventory named one", async () => {
      const rig: Rig = await setUp();
      rig.fake.nameDeviceInNextReply({ name: "Lab, left" });
      await granted(rig, 1);
      rig.fake.listDevices([]);
      await granted(rig, 2, {}, { token: secrets.two });

      const comma = await forwarded(rig, () => shard(rig, 1));
      const unnamed = await forwarded(rig, () => shard(rig, 2, {}, secrets.two));

      expect(flagsOf(comma)["device"]).toBe(idOf(rig, 1));
      expect(flagsOf(unnamed)["device"]).toBe(idOf(rig, 2));

      await forwarded(rig, () => shard(rig, 2, {}, secrets.two));
      const listed = rig.fake.requests
        .filter((r) => r.params?.["command"] === "devices")
        .map((r) =>
          String((r.params?.["meta"] as Record<string, unknown> | undefined)?.["leaseId"]),
        );
      expect(listed.length).toBe(new Set(listed).size);
    });

    // why: agent-device 0.21.28 answers an allocate with `{ lease }` and no device; only its `devices` inventory names a device, and its session check matches `--device` by that name alone (#971).
    it("`test --shard-all` with no `--device` names each of the token's leased devices by the name agent-device's inventory gives it when the allocate reply named no device, for an agent holding one device and one holding two", async () => {
      const rig: Rig = await setUp();
      rig.fake.nameDeviceInNextReply("none");
      await granted(rig, 1);
      rig.fake.nameDeviceInNextReply("none");
      await granted(rig, 2, {}, { token: secrets.two });
      rig.fake.nameDeviceInNextReply("none");
      await granted(rig, 3, {}, { token: secrets.two });
      rig.fake.listDevices([
        { id: idOf(rig, 1), name: "simlock-aaaa", platform: "ios" },
        { id: idOf(rig, 2), name: "simlock-bbbb", platform: "ios" },
        { id: idOf(rig, 3), name: "simlock-cccc", platform: "ios" },
      ]);

      const one = await forwarded(rig, () => shard(rig, 1, { shardAll: 1 }));
      const two = await forwarded(rig, () => shard(rig, 2, {}, secrets.two));

      expect(flagsOf(one)["device"]).toBe("simlock-aaaa");
      expect(String(flagsOf(two)["device"]).split(",").sort()).toEqual([
        "simlock-bbbb",
        "simlock-cccc",
      ]);
    });

    it('`test --shard-split 2` with `device: " , "` is filled as if no list were sent; from a token that holds no device it is refused with `refused: no device leased; run open first`', async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const split = (token: string, n: number | undefined) =>
        runCommand(rig, "test", n, { flags: { device: " , ", shardSplit: 2 } }, { token });

      const params = await forwarded(rig, () => split(secrets.one, 1));

      expect(flagsOf(params)["device"]).toBe(nameOf(rig, 1));
      await refused(rig, () => split(secrets.two, undefined), noDeviceLeased);
    });
  });

  describe("rule 8, install", () => {
    it('`install` with `meta.uploadedArtifactId` is forwarded; without it, with `""` and with `"  "` it is refused with `send the app from your machine as an upload`', async () => {
      const rig = await setUp();
      const install = (meta: Record<string, unknown>) =>
        runCommand(rig, "install", undefined, {
          meta,
          positionals: ["MyApp", "remote:/Users/ci/MyApp.app"],
        });
      await forwarded(rig, () => install({ uploadedArtifactId: "art-1" }));

      await refused(rig, () => install({}), uploadOnly);
      await refused(rig, () => install({ uploadedArtifactId: "" }), uploadOnly);
      await refused(rig, () => install({ uploadedArtifactId: "  " }), uploadOnly);
    });

    it('`reinstall` without an upload is refused; batch steps `install` and `" Install "` are refused and no step reaches agent-device', async () => {
      const rig = await setUp();
      await forwarded(rig, () =>
        runCommand(rig, "reinstall", undefined, { meta: { uploadedArtifactId: "art-1" } }),
      );
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));
      const before = commandsReceived(rig).length;

      await refused(rig, () => runCommand(rig, "reinstall", undefined), uploadOnly);
      await refused(rig, () => batch(rig, undefined, [{ command: "install" }]), uploadOnly);
      await refused(
        rig,
        () => batch(rig, undefined, [{ command: "snapshot" }, { command: " Install " }]),
        uploadOnly,
      );
      expect(commandsReceived(rig)).toHaveLength(before);
    });

    it("a batch with an upload in `meta` still refuses its `install` step, and forwards when it has no install step", async () => {
      const rig = await setUp();
      const withUpload = (steps: readonly Record<string, unknown>[]) =>
        runCommand(rig, "batch", undefined, {
          flags: { batchSteps: steps },
          meta: { uploadedArtifactId: "art-1" },
        });
      await forwarded(rig, () => withUpload([{ command: "snapshot" }]));
      const before = commandsReceived(rig).length;

      await refused(rig, () => withUpload([{ command: "install" }]), uploadOnly);
      expect(commandsReceived(rig)).toHaveLength(before);
    });
  });

  describe("rule 9, batch devices", () => {
    it('batch steps `devices` and `" DEVICES "` are refused', async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      for (const step of ["devices", " DEVICES "]) {
        await refused(
          rig,
          () => batch(rig, undefined, [{ command: step }]),
          "refused: run devices on its own",
        );
      }
    });
  });

  describe("the devices filter", () => {
    const three = [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }];
    const listedIds = async (response: Response): Promise<unknown> => {
      const answer = await envelopeOf(response);
      const data = answer.result?.["data"] as { devices: { id: string }[] } | undefined;
      expect(Array.isArray(data?.devices), "expected a devices list in result.data").toBe(true);
      return data?.devices.map((device) => device.id);
    };

    it("`devices` before open answers an empty list while agent-device lists three devices; after open it answers only the leased device, without agent B's", async () => {
      const rig = await setUp();
      await granted(rig, 2, {}, { token: secrets.two });
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }]);
      const before = commandsReceived(rig).length;

      expect(await listedIds(await runCommand(rig, "devices", undefined))).toEqual([]);
      expect(commandsReceived(rig)).toHaveLength(before);
      await granted(rig, 1);
      rig.fake.listDevices([...three, { id: idOf(rig, 2) }, { id: idOf(rig, 1) }]);

      expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([idOf(rig, 1)]);
    });

    it("`devices` for an agent holding two devices answers both, and after simlock released one of the two leases (no heartbeat sent since), only the other", async () => {
      const rig = await setUp();
      await granted(rig, 1, { ttlMs: 60_000 });
      await granted(rig, 2, { ttlMs: 600_000 });
      rig.fake.listDevices([...three, { id: idOf(rig, 1) }, { id: idOf(rig, 2) }]);

      expect(
        ((await listedIds(await runCommand(rig, "devices", undefined))) as string[]).sort(),
      ).toEqual([idOf(rig, 1), idOf(rig, 2)].sort());
      await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
      await expect.poll(() => listed(rig)).toEqual([hex(2)]);

      expect(await listedIds(await runCommand(rig, "devices", undefined))).toEqual([idOf(rig, 2)]);
    });

    it("a `devices` error answer from agent-device passes unchanged; a success with no list at `data.devices`, a body over 1 MiB, a non-JSON body and a list holding a non-object each answer `could not read the device list from the worker holding lease <id>`; `devices` with `meta.requestProgress` is refused", async () => {
      const rig: Rig = await setUp();
      await granted(rig, 1);
      rig.fake.listDevices([{ id: idOf(rig, 1) }]);
      expect(await listedIds(await runCommand(rig, "devices", 1))).toEqual([idOf(rig, 1)]);

      const failure = {
        error: {
          code: -32000,
          data: { code: "COMMAND_FAILED", message: "inventory down" },
          message: "inventory down",
        },
        id: 1,
        jsonrpc: "2.0",
      };
      rig.fake.answerDevicesWith(JSON.stringify(failure));
      expect(await envelopeOf(await runCommand(rig, "devices", 1))).toMatchObject({
        error: { message: "inventory down" },
      });
      const unusable = [
        JSON.stringify({ id: 1, jsonrpc: "2.0", result: { data: {}, ok: true } }),
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            data: { devices: [{ id: idOf(rig, 1) }], pad: "x".repeat(1024 * 1024) },
            ok: true,
          },
        }),
        "not json",
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: { data: { devices: [{ id: idOf(rig, 1) }, "stray"] }, ok: true },
        }),
      ];
      for (const body of unusable) {
        rig.fake.answerDevicesWith(body);
        expect((await envelopeOf(await runCommand(rig, "devices", 1))).error).toMatchObject({
          data: {
            message: `could not read the device list from the worker holding lease ${hex(1)}`,
          },
        });
      }
      await refused(
        rig,
        () => runCommand(rig, "devices", 1, { meta: { requestProgress: true } }),
        "refused: devices does not stream through simlock",
      );
    });
  });

  describe("the token's leased devices", () => {
    it("a `test` shard fill whose lease check fails answers `COMMAND_FAILED` with `could not check your leases; try again` and reaches nothing", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      const tap = tapDispatch(rig);
      const sharded = () => runCommand(rig, "test", 1, { flags: { shardAll: 2 } });
      await forwarded(rig, sharded);
      tap.rejectNext("lease.list");
      const before = rig.fake.requests.length;

      const answer = await envelopeOf(await sharded());

      expect(answer.error).toMatchObject({
        data: { code: "COMMAND_FAILED", message: "could not check your leases; try again" },
      });
      expect(rig.fake.requests.length).toBe(before);
    });

    it("a `devices` whose lease check fails answers `COMMAND_FAILED` with `could not check your leases; try again`, not an empty list", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      rig.fake.listDevices([{ id: idOf(rig, 1) }]);
      const tap = tapDispatch(rig);
      tap.rejectNext("lease.list");

      const answer = await envelopeOf(await runCommand(rig, "devices", 1));

      expect(answer.error).toMatchObject({
        data: { code: "COMMAND_FAILED", message: "could not check your leases; try again" },
      });
    });

    it("a batch whose `batchSteps` is not a list is refused with `refused: malformed batchSteps`", async () => {
      const rig = await setUp();
      await forwarded(rig, () => batch(rig, undefined, [{ command: "snapshot" }]));

      await refused(
        rig,
        () => runCommand(rig, "batch", undefined, { flags: { batchSteps: "snapshot" } }),
        "refused: malformed batchSteps",
      );
    });

    it("a `flags`, `input` or `runtime` that is not an object, a batch step that is not an object or whose `command` is not a string, and a `meta.deviceKey` that is not a string are each refused with their `malformed` message", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: {} }));

      for (const key of ["flags", "input", "runtime"]) {
        await refused(
          rig,
          () => runCommand(rig, "snapshot", 1, { [key]: "text" }),
          `refused: malformed ${key}`,
        );
      }
      await refused(
        rig,
        () => batch(rig, 1, ["snapshot"] as unknown as Record<string, unknown>[]),
        "refused: malformed batchSteps",
      );
      await refused(rig, () => batch(rig, 1, [{ command: 5 }]), "refused: malformed command");
      await refused(
        rig,
        () => runCommand(rig, "snapshot", 1, { meta: { deviceKey: 5 } }),
        "refused: malformed deviceKey",
      );
    });
  });

  describe("rule 10, commands agent-device runs without a lease", () => {
    it("`capabilities` with no selector reaches agent-device with the leased device's id; from a token holding no device it is refused; `doctor` the same", async () => {
      const rig = await setUp();
      await granted(rig, 1);
      for (const name of ["capabilities", "doctor"]) {
        const params = await forwarded(rig, () => runCommand(rig, name, 1));
        expect(flagsOf(params)["udid"]).toBe(idOf(rig, 1));
        await refused(
          rig,
          () => runCommand(rig, name, undefined, {}, { token: secrets.two }),
          "refused: name the device with --udid <id>; run devices to see yours",
        );
      }
    });

    it("`capabilities` naming no lease is filled with the token's only device; with two devices it is refused unless `platform` leaves one, and then it gets that device's `serial` on Android", async () => {
      const rig = await setUp({ drivers: bothDrivers });
      await granted(rig, 1, {}, { token: secrets.two });
      const only = await forwarded(rig, () =>
        runCommand(rig, "capabilities", undefined, {}, { token: secrets.two }),
      );
      expect(flagsOf(only)["udid"]).toBe(idOf(rig, 1));

      await granted(rig, 2, { device: "Pixel 8", platform: "android" }, { token: secrets.two });
      await refused(
        rig,
        () => runCommand(rig, "capabilities", undefined, {}, { token: secrets.two }),
        "refused: name the device with --udid <id>; run devices to see yours",
      );
      const android = await forwarded(rig, () =>
        runCommand(
          rig,
          "capabilities",
          undefined,
          { flags: { platform: "android" } },
          { token: secrets.two },
        ),
      );
      expect(flagsOf(android)["serial"]).toBe(idOf(rig, 2));
      expect(flagsOf(android)).not.toHaveProperty("udid");
    });
  });

  it("A runner sends `boot` on its lease and simlock answers it; agent-device gets no `boot`", async () => {
    for (const scenario of [
      { platform: "ios", model: "iPhone 16", kind: "simulator", target: "mobile", flags: {} },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: { target: "tv" },
      },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: {},
        runtime: { udid: "another-device" },
      },
      { platform: "android", model: "Pixel 8", kind: "emulator", target: "mobile", flags: {} },
      { platform: "ios", model: "Apple TV 4K", kind: "simulator", target: "tv", flags: {} },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: { udid: true },
      },
      {
        platform: "ios",
        model: "iPhone 16",
        kind: "simulator",
        target: "mobile",
        flags: { device: true },
      },
      {
        platform: "android",
        model: "Pixel 8",
        kind: "device",
        target: "mobile",
        flags: {},
        physical: true,
      },
    ]) {
      const rig: Rig = scenario.physical
        ? await setUpWithPhone()
        : await setUp({ drivers: bothDrivers });
      rig.fake.nameDeviceInNextReply("none");
      await granted(rig, 1, {
        platform: scenario.platform,
        target: scenario.target,
        ...(scenario.physical ? { physical: true } : {}),
      });
      const address = scenario.physical ? phoneSerial : idOf(rig, 1);
      const flags =
        "udid" in scenario.flags
          ? { udid: address }
          : "device" in scenario.flags
            ? { device: `simlock-${address}` }
            : scenario.flags;
      const answer = await envelopeOf(
        await runCommand(rig, "boot", 1, {
          flags,
          ...(scenario.runtime && { runtime: scenario.runtime }),
        }),
      );
      expect(answer.result).toMatchObject({
        ok: true,
        data: {
          platform: scenario.platform,
          target: scenario.target,
          device: "device" in scenario.flags ? `simlock-${address}` : scenario.model,
          id: address,
          kind: scenario.kind,
          booted: true,
        },
      });
      expect(
        commandsReceived(rig).filter((request) => request.params?.["command"] === "boot"),
      ).toEqual([]);
    }

    const clock = new FakeClock(1_000);
    const identity = tokenIdentity("tok_one");
    const leaseId = hex(1);
    const worker = {
      id: "w1",
      platforms: ["ios"] as const,
      leaseMaxTtlMs: 120_000,
      drained: false,
    };
    const relay = vi.fn(async () => Response.json({ ok: false }));
    const fleet: FleetPort = {
      instanceId: "gw1",
      startedAt: 0,
      capableWorkers: () => [worker],
      holder: () => worker,
      leaseOf: () => ({ ownerId: identity.principal, workerId: worker.id }),
      leasesOf: () => [
        {
          leaseId,
          requesterId: leaseId,
          workerId: worker.id,
          connected: true,
          refreshed: true,
          listed: {
            address: "adopted-udid",
            platform: "ios",
            model: "Apple TV 4K",
            deviceClass: "tv",
            ttlMs: 120_000,
            ttlDeadline: 121_000,
          },
        },
      ],
      reach: () => ({ connected: true, refreshed: true }),
      relay,
      onLeaseRemoved: () => undefined,
    };
    const link = new RelayHostLink({ clock, fleet, leaseMaxTtlMs: 120_000 });
    const front = createFront({
      clock,
      dispatch: (() => {
        throw new Error("unexpected dispatch");
      }) as unknown as HttpDispatch,
      link,
      logger: new NoopLogger(),
      map: new FrontMap(clock),
      maxRunMs: 120_000,
      renewals: new Renewals(clock),
    });
    const adopted = await envelopeOf(
      await front.handle(
        new Request("http://simlock.test/v1/agent-device/rpc", {
          method: "POST",
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "agent_device.command",
            params: { command: "boot", meta: { leaseId } },
          }),
        }),
        identity,
      ),
    );
    expect(adopted.result).toMatchObject({
      ok: true,
      data: {
        platform: "ios",
        target: "tv",
        device: "Apple TV 4K",
        id: "adopted-udid",
        kind: "simulator",
        booted: true,
      },
    });
    expect(relay).not.toHaveBeenCalled();
    link.dispose();
  });
  it("A `boot` that names no lease, another token's lease, an ended lease or another device is refused", async () => {
    const rig = await setUp({ drivers: bothDrivers });
    await granted(rig, 1);
    await granted(rig, 2, {}, { token: secrets.two });
    expect((await envelopeOf(await runCommand(rig, "boot", 1))).result).toMatchObject({ ok: true });
    for (const [lease, fields, message] of [
      [undefined, {}, "refused: boot names no lease; open a device first"],
      [2, {}, simlockPicks],
      [1, { flags: { udid: idOf(rig, 2) } }, simlockPicks],
      [1, { flags: { platform: "android" } }, simlockPicks],
      [undefined, { flags: { udid: idOf(rig, 1) } }, simlockPicks],
    ] as const) {
      expect((await envelopeOf(await runCommand(rig, "boot", lease, fields))).error).toMatchObject(
        refusal(message),
      );
    }
    await rig.daemon.dispatch("lease.release", { leaseId: hex(1) }, adminSession);
    await runCommand(rig, "devices", undefined);
    expect((await envelopeOf(await runCommand(rig, "boot", 1))).error).toMatchObject(
      refusal("lease ended by simlock; run disconnect, then open", "UNAUTHORIZED"),
    );
    await granted(rig, 3);
    await release(rig, 3);
    expect((await envelopeOf(await runCommand(rig, "boot", 3))).error).toMatchObject(
      refusal("refused: this lease has ended; open a device"),
    );
  });
});
