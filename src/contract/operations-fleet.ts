import { z } from "zod";
import { defineOperation } from "./operation-definition.js";
import { daemonUpdate } from "./operations-admin.js";
import { componentVersionSchema, leaseIdSchema } from "./operations-lease-request.js";
import { relayChannelSchema, relayHeadersSchema, relayIdSchema } from "./relay.js";
import {
  capabilityNameSchema,
  inboxItemSchema,
  platformSchema,
  updateRequestedVersionSchema,
  workerViewSchema,
} from "./schemas.js";

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const workerList = defineOperation({
  name: "worker.list",
  role: "admin",
  effect: "read",
  input: z.object({}),
  output: z.object({ workers: z.array(workerViewSchema) }),
});

/**
 * ADR 0005 §9: a drained worker keeps its existing leases and receives no new dispatches --
 * the operator's tool for taking a machine down without killing anyone's device. This PR
 * records the flag (persisted, so it survives a worker reconnect and a gateway restart) and
 * reports it; #118's dispatcher is what honours it, because this PR has no dispatch to skip.
 *
 * Idempotent: draining an already-drained worker succeeds and changes nothing. An id the
 * gateway has no view of is `UNKNOWN_WORKER` -- draining a machine that is not in the fleet is
 * a typo, and answering "done" would leave an operator believing a machine was taken out of
 * service when nothing was.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const workerDrain = defineOperation({
  name: "worker.drain",
  role: "admin",
  effect: "write",
  input: z.object({ workerId: z.string().min(1) }),
  output: z.object({ workerId: z.string(), drained: z.literal(true) }),
});

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const workerUndrain = defineOperation({
  name: "worker.undrain",
  role: "admin",
  effect: "write",
  input: z.object({ workerId: z.string().min(1) }),
  output: z.object({ workerId: z.string(), drained: z.literal(false) }),
});

/**
 * ADR 0005 §8: forgets a *disconnected* worker's view. A connected one is refused with
 * `WORKER_CONNECTED` -- removing it would only make the gateway forget a machine that is about
 * to announce itself again on its very next refresh, which is a confusing no-op rather than an
 * operator action.
 *
 * `removed: false` is the answer for an id with no view: unlike drain, "forget this" is
 * already true of something the gateway has never heard of or has already forgotten, so it is
 * an outcome to report rather than an error to raise (the same shape `token.revoke` uses).
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const workerRemove = defineOperation({
  name: "worker.remove",
  role: "admin",
  effect: "write",
  input: z.object({ workerId: z.string().min(1) }),
  output: z.object({ workerId: z.string(), removed: z.boolean() }),
});

// why: ADR 0042 §2: the gateway sends `daemon.update` over that worker's uplink and answers with the worker's own answer plus the id.
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const workerUpdate = defineOperation({
  name: "worker.update",
  role: "admin",
  effect: "write",
  input: z.object({
    workerId: z.string().min(1),
    version: updateRequestedVersionSchema.optional(),
    force: z.boolean().optional(),
  }),
  output: daemonUpdate.output.extend({ workerId: z.string() }),
});

/**
 * Installs one iOS simulator runtime or Android system image without leasing a device (ADR 0010
 * §6). Admin-only: the command is an operator's consent to a multi-GB download, which
 * `downloads.policy: "never"` still refuses (§4). Not durable: a daemon stop ends the install,
 * and running it again is the recovery. `component` echoes the version asked for; `version` is
 * the exact one installed or found.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const componentInstall = defineOperation({
  name: "component.install",
  role: "admin",
  effect: "write",
  input: z.object({ platform: platformSchema, version: componentVersionSchema }),
  output: z.object({
    platform: platformSchema,
    component: z.string(),
    outcome: z.enum(["installed", "already-installed"]),
    version: z.string(),
  }),
});

/**
 * Every installed iOS simulator runtime and Android system image on this machine, ordered by
 * platform, then version, then variant. A read for any session. `installedBySimlock` is true only
 * when Simlock's record of an install names this exact component; `installedAt` is that
 * record's time. `devices` counts Simlock's own devices of this platform and version in any
 * state but deleted, so two variants of one version show the same count; `foreignDevices`
 * counts the devices outside Simlock that use it. `variant` tells two components of one
 * version apart, in the platform's own words; `sizeBytes` is absent when it could not be read.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const componentList = defineOperation({
  name: "component.list",
  role: "agent",
  effect: "read",
  input: z.object({ platform: platformSchema.optional() }),
  output: z.object({
    components: z.array(
      z.object({
        platform: platformSchema,
        version: z.string(),
        variant: z.string().optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        installedBySimlock: z.boolean(),
        installedAt: z.number().int().optional(),
        devices: z.number().int().nonnegative(),
        foreignDevices: z.number().int().nonnegative(),
      }),
    ),
  }),
});

const WORKER_ID_MAX_LENGTH = 128;

/** The longest error message a relayed result carries. A worker's message is a claim, cut to
 * this before it is stored in a result (safety rule 10). */
export const WORKER_RESULT_MESSAGE_MAX_LENGTH = 1024;

const workerInstallTargetsSchema = z.union([
  z.literal("all"),
  z
    .array(z.string().min(1).max(WORKER_ID_MAX_LENGTH))
    .min(1)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length, "worker ids must be distinct"),
]);

const workerInstallResultSchema = z.object({
  workerId: z.string(),
  label: z.string().optional(),
  outcome: z.enum(["installed", "already-installed", "refused", "failed", "skipped", "unknown"]),
  version: z.string().max(64).optional(),
  error: z
    .object({
      code: z.string().max(64),
      message: z.string().max(WORKER_RESULT_MESSAGE_MAX_LENGTH),
    })
    .optional(),
});

/**
 * ADR 0010 §7: installs one component on named workers, or on every connected one, through a
 * gateway. The gateway asks each target at the same time with `component.install`, and each
 * worker answers for itself under its own `downloads.policy`. One result per worker, in
 * ascending worker id. Progress arrives as `component-progress` pushes carrying `workerId`.
 * A worker answers `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012 §2).
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const workerInstallComponent = defineOperation({
  name: "worker.install-component",
  role: "admin",
  effect: "write",
  input: z.object({
    platform: platformSchema,
    version: componentVersionSchema,
    workers: workerInstallTargetsSchema,
  }),
  output: z.object({ results: z.array(workerInstallResultSchema) }),
});

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const componentRemove = defineOperation({
  name: "component.remove",
  role: "admin",
  effect: "write",
  input: z.object({
    platform: platformSchema,
    version: componentVersionSchema,
    dryRun: z.boolean().optional(),
  }),
  output: z.object({
    platform: platformSchema,
    version: z.string(),
    outcome: z.enum(["removed", "would-remove"]),
    sizeBytes: z.number().int().nonnegative().optional(),
    residue: z.string().optional(),
  }),
});

const ENROLLED_DEVICE_ID_MAX_LENGTH = 200;

const enrollmentDeviceIdSchema = z
  .string()
  .min(1)
  .max(ENROLLED_DEVICE_ID_MAX_LENGTH)
  .refine(
    (id) => [...id].every((character) => !/\s/u.test(character) && !isControlCharacter(character)),
    "must not contain whitespace or control characters",
  )
  .refine((id) => !id.startsWith("-"), "must not start with -");

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const deviceAdd = defineOperation({
  name: "device.add",
  role: "admin",
  effect: "write",
  input: z.object({ platform: platformSchema, id: enrollmentDeviceIdSchema }).strict(),
  output: z.object({
    id: z.string(),
    driverDeviceId: z.string(),
    platform: platformSchema,
    model: z.string(),
    osVersion: z.string(),
    class: z.enum(["phone", "tablet"]),
    appCount: z.number().int().nonnegative(),
    reenrolled: z.boolean(),
  }),
});

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const deviceRemove = defineOperation({
  name: "device.remove",
  role: "admin",
  effect: "write",
  input: z.object({ id: enrollmentDeviceIdSchema }).strict(),
  output: z.object({ id: z.string(), driverDeviceId: z.string() }),
});

const RELAY_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const relayUrlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  });

/**
 * One HTTP exchange a gateway hands to a module on a worker, over the gateway's uplink. The
 * request body arrives, and the response body leaves, on the byte channel `channel` names (ADR 0028);
 * the head leaves as a `relay-head` push keyed by this call's frame id. The
 * answer comes once the response body has ended, or `{ cancelled: true }` once a `relay.cancel` took
 * effect. With `twoWay` (GET, no body) both directions of the channel stay open: the answer comes once
 * both have ended. Admin only, and on a worker only the gateway's own uplink session may call it.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const relayRequest = defineOperation({
  name: "relay.request",
  role: "admin",
  effect: "write",
  input: z
    .object({
      relayId: relayIdSchema,
      target: capabilityNameSchema,
      method: z.enum(RELAY_METHODS),
      url: relayUrlSchema,
      headers: relayHeadersSchema,
      tenant: z.string().min(1).max(300),
      leaseId: leaseIdSchema.optional(),
      hasBody: z.boolean(),
      twoWay: z.literal(true).optional(),
      channel: relayChannelSchema,
    })
    .strict()
    .refine((input) => !input.hasBody || (input.method !== "GET" && input.method !== "HEAD"), {
      message: "hasBody is not allowed with GET or HEAD",
    })
    .refine((input) => input.twoWay !== true || (input.method === "GET" && !input.hasBody), {
      message: "twoWay needs GET and no body",
    }),
  output: z.object({ cancelled: z.literal(true).optional() }),
});

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const relayCancel = defineOperation({
  name: "relay.cancel",
  role: "admin",
  effect: "write",
  input: z.object({ relayId: relayIdSchema }).strict(),
  output: z.object({}),
});

/**
 * why: ADR 0035 §1: asks the gateway to post one sample message to one of its alert destinations,
 * once, outside the destination's queue. `destination` is only looked up by name among the
 * configured ones, never used in a URL.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const alertsTest = defineOperation({
  name: "alerts.test",
  role: "admin",
  effect: "write",
  input: z.object({ destination: z.string().min(1).max(32) }),
  output: z.object({ destination: z.string(), status: z.number() }),
});

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const inboxGet = defineOperation({
  name: "inbox.get",
  role: "admin",
  effect: "read",
  input: z.object({}),
  output: z.object({ items: z.array(inboxItemSchema) }),
});

const identityGet = defineOperation({
  name: "identity.get",
  role: "agent",
  effect: "read",
  input: z.object({}),
  output: z.object({
    principal: z.string(),
    name: z.string(),
    role: z.enum(["admin", "agent"]),
    via: z.enum(["token", "proxy", "socket", "uplink"]),
    signOutUrl: z.string().optional(),
  }),
});

export { identityGet };
