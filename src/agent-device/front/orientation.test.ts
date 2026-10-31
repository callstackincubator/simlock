import { describe, expect, it } from "vitest";

import { tokenIdentity } from "../../auth/testing.js";
import { DispatchError } from "../../daemon/dispatch.js";
import type { HttpDispatch } from "../../http/dispatcher-session.js";
import { FakeClock, NoopLogger } from "../../ports/index.js";
import { FRONT_PREFIX } from "../shared/paths.js";
import type { FrontContext } from "./context.js";
import { FrontMap } from "./front-map.js";
import { createFront } from "./front.js";
import type { HostLink } from "./host-link.js";
import { Renewals } from "./renewals.js";

const agent = tokenIdentity("tok_a");
const leaseId = "a".repeat(32);
const ttlMs = 600_000;
const forwardedAnswer = { forwarded: true };

interface Rig {
  readonly handle: (command: string, positionals?: readonly string[]) => Promise<Response>;
  readonly rotations: unknown[];
  readonly forwarded: unknown[];
  readonly clock: FakeClock;
}

interface RigOptions {
  readonly gateway: boolean;
  readonly model: string;
  readonly adopted?: boolean;
  readonly rotate?: () => Promise<unknown>;
}

function rig(options: RigOptions): Rig {
  const clock = new FakeClock(1_000);
  const map = new FrontMap(clock);
  const rotations: unknown[] = [];
  const forwarded: unknown[] = [];
  const entry = {
    address: "udid-1",
    deadline: clock.now() + ttlMs,
    identity: agent,
    model: options.model,
    platform: "ios" as const,
    target: "mobile",
    ttlMs,
  };
  if (!options.adopted) map.add(leaseId, entry);
  const link: HostLink = {
    adoptable: () => (options.adopted ? [{ ...entry, leaseId, ttlDeadline: entry.deadline }] : []),
    forward: async (request) => {
      forwarded.push(JSON.parse(await request.text()));
      return Response.json({ id: 1, jsonrpc: "2.0", result: { data: forwardedAnswer, ok: true } });
    },
    readsLeaseHeader: options.gateway,
    status: () => Promise.resolve({ platforms: ["ios", "android"], state: "running" }),
  };
  const dispatch = ((operation: string, input: unknown) => {
    if (operation === "device.rotate") {
      rotations.push(input);
      return (options.rotate ?? (() => Promise.resolve({})))();
    }
    if (operation === "lease.list") {
      return Promise.resolve({
        leases: [{ id: leaseId, requesterId: leaseId, ttlDeadline: clock.now() + ttlMs * 10 }],
      });
    }
    return Promise.resolve({});
  }) as unknown as HttpDispatch;
  const context: FrontContext = {
    clock,
    dispatch,
    link,
    logger: new NoopLogger(),
    map,
    maxRunMs: 3_600_000,
    renewals: new Renewals(clock),
  };
  const mount = createFront(context);
  return {
    clock,
    forwarded,
    handle: (command, positionals = []) =>
      Promise.resolve(
        mount.handle(
          new Request(`http://simlock.test${FRONT_PREFIX}/rpc`, {
            body: JSON.stringify({
              id: 7,
              jsonrpc: "2.0",
              method: "agent_device.command",
              params: { command, meta: { leaseId }, positionals },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
          agent,
        ),
      ),
    rotations,
  };
}

interface Envelope {
  readonly id?: unknown;
  readonly result?: { readonly ok: boolean; readonly data: Record<string, unknown> };
  readonly error?: {
    readonly data: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly reason: string };
    };
  };
}

async function answer(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

function unconfirmed(name: string) {
  return {
    action: "orientation",
    confirmed: false,
    message: `Rotation requested: ${name} (unconfirmed)`,
    orientation: name,
    warning: `Requested ${name}; the device owner reported no resulting orientation, so the rotation is unconfirmed.`,
  };
}

const unknownMessage = (input: string) =>
  `Unknown orientation ${input}; use portrait, portrait-upside-down, landscape-left or landscape-right`;

describe("the agent-device front's orientation command", () => {
  it("answers `orientation <name>` on a Simlock iOS-simulator lease with agent-device's unconfirmed reply through device.rotate, without the command reaching agent-device; `auto` or an unknown name is `INVALID_ARGS`, a missing helper `COMMAND_FAILED`, a gone worker the worker-unreachable reply", async () => {
    const rotated = [
      ["landscape-left", "landscape_left", "landscape-left"],
      ["Left", "landscape_left", "landscape-left"],
      ["right", "landscape_right", "landscape-right"],
      ["upside-down", "portrait_upside_down", "portrait-upside-down"],
      ["portrait", "portrait", "portrait"],
    ] as const;
    for (const gateway of [true, false]) {
      for (const model of ["iPhone 17 Pro", "iPad Pro 13-inch (M5)"]) {
        for (const [typed, sent, named] of rotated) {
          const { handle, rotations, forwarded, clock } = rig({ gateway, model });
          const response = await handle("orientation", [typed]);
          const body = await answer(response);
          const label = `${gateway ? "gateway" : "worker"} ${model} ${typed}`;
          expect(body.id, label).toBe(7);
          expect(body.result, label).toEqual({ data: unconfirmed(named), ok: true });
          expect(rotations, label).toEqual([{ leaseId, orientation: sent }]);
          expect(forwarded, label).toEqual([]);
          expect(clock.pendingTimerCount, label).toBe(0);
        }
      }
    }

    const adopted = rig({ adopted: true, gateway: true, model: "iPhone 17 Pro" });
    const adoptedBody = await answer(await adopted.handle("orientation", ["landscape-right"]));
    expect(adoptedBody.result).toEqual({ data: unconfirmed("landscape-right"), ok: true });
    expect(adopted.rotations).toEqual([{ leaseId, orientation: "landscape_right" }]);
    expect(adopted.forwarded).toEqual([]);

    for (const typed of [["auto"], ["sideways"], []]) {
      const { handle, rotations, forwarded } = rig({
        gateway: false,
        model: "iPad Pro 13-inch (M5)",
      });
      const response = await handle("orientation", typed);
      const body = await answer(response);
      expect(response.status).toBe(400);
      expect(body.error?.data).toEqual({
        code: "INVALID_ARGS",
        message: unknownMessage(typed[0] ?? ""),
      });
      expect(rotations).toEqual([]);
      expect(forwarded).toEqual([]);
    }

    const failures = [
      {
        error: new DispatchError("INPUT_UNAVAILABLE", "the input helper could not start", {
          leaseId,
          reason: "x",
        }),
        expected: {
          code: "COMMAND_FAILED",
          message: "the input helper could not start",
          status: 502,
        },
      },
      {
        error: new Error("rotate blew up"),
        expected: { code: "COMMAND_FAILED", message: "rotate blew up", status: 502 },
      },
      {
        error: new DispatchError("WORKER_UNREACHABLE", "worker w1 is not connected", {
          workerId: "w1",
        }),
        expected: {
          code: "COMMAND_FAILED",
          details: { reason: "WORKER_UNREACHABLE" },
          message:
            "agent-device is not available on this simlock: the worker holding this device is not connected to the gateway; try again",
          status: 503,
        },
      },
    ];
    for (const { error, expected } of failures) {
      const { handle, forwarded, clock } = rig({
        gateway: true,
        model: "iPhone 17 Pro",
        rotate: () => Promise.reject(error),
      });
      const response = await handle("orientation", ["landscape-left"]);
      const body = await answer(response);
      const { status, ...data } = expected;
      expect(response.status, data.message).toBe(status);
      expect(body.error?.data, data.message).toEqual(data);
      expect(forwarded, data.message).toEqual([]);
      expect(clock.pendingTimerCount, data.message).toBe(0);
    }
  });
});
