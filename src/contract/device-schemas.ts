import { z } from "zod";

import { CONTROL_CHARACTERS, deviceModeSchema, leaseIdentitySchema } from "./schema-parts.js";

export const platformSchema = z.enum(["ios", "android"]);
export type Platform = z.infer<typeof platformSchema>;

export const deviceClassSchema = z.enum([
  "phone",
  "tablet",
  "watch",
  "tv",
  "vision",
  "auto",
  "desktop",
]);
export type DeviceClass = z.infer<typeof deviceClassSchema>;

export const deviceStateSchema = z.enum([
  "provisioning",
  "ready",
  "leased",
  "reclaiming",
  "quarantined",
  "absent",
  "shutdown",
  "deleted",
]);

export const absentReasonSchema = z.enum(["locked", "untrusted", "not-present"]);

const devicePresenceSchema = z.discriminatedUnion("present", [
  z.object({ present: z.literal(true) }),
  z.object({ present: z.literal(false), reason: absentReasonSchema }),
]);

export const physicalClassSchema = z.enum(["phone", "tablet"]);

function checkDeviceType(
  device: { readonly physical: boolean; readonly mode?: unknown; readonly class?: unknown },
  context: z.RefinementCtx,
  requireClass: boolean,
): void {
  if (device.physical) {
    if (device.mode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A physical device has no mode",
        path: ["mode"],
      });
    }
    if (requireClass && device.class === undefined) {
      context.addIssue({
        code: "custom",
        message: "A physical device has a class",
        path: ["class"],
      });
    }
    return;
  }
  if (device.mode === undefined) {
    context.addIssue({
      code: "custom",
      message: "A virtual device has a mode",
      path: ["mode"],
    });
  }
  if (device.class !== undefined) {
    context.addIssue({
      code: "custom",
      message: "A virtual device has no class",
      path: ["class"],
    });
  }
}

const IMAGE_TAG_MAX = 64;

/**
 * why: an image tag is bounded here, before a driver sees it, because it arrives over the wire
 * and is stored with the request and on the device.
 */
export const imageTagSchema = z
  .string()
  .min(1)
  .max(IMAGE_TAG_MAX)
  .regex(/^[A-Za-z0-9_.-]+$/, "imageTag may contain only letters, digits, '_', '.' and '-'");

/** why: a baseline's name is its handle on the command line and in a path-like URL, so it is lowercase and starts with a letter or digit. */
export const baselineNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "baseline name may contain only a-z, 0-9, '.', '_' and '-', and must start with a letter or digit",
  );

// oxlint-disable-next-line no-control-regex -- refusing control characters is the whole point.
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f]*$/;

export const baselineNoteSchema = z
  .string()
  .max(200)
  .regex(NO_CONTROL_CHARACTERS, "baseline note may not contain control characters");

/** why: the bound a worker id has on the wire, shared by the events page, a baseline entry and `baseline.remove`. */
export const WORKER_ID_MAX = 128;

/** why: one baseline as `baseline.save` and `baseline.list` answer it; `sizeBytes` is absent when the source's size could not be counted. */
export const baselineEntrySchema = z.object({
  name: baselineNameSchema,
  version: z.number().int().min(1),
  platform: platformSchema,
  model: z.string().max(64),
  osVersion: z.string().max(64),
  mode: z.enum(["slim", "full"]),
  imageTag: imageTagSchema.optional(),
  note: baselineNoteSchema.optional(),
  sizeBytes: z.number().int().min(0).optional(),
  savedAt: z.string().max(64),
  staleReason: z.string().max(300).optional(),
  /** why: set only by a gateway's `baseline.list`: the worker that holds the baseline, what `--worker` takes. */
  workerId: z.string().min(1).max(WORKER_ID_MAX).optional(),
});

export type BaselineEntry = z.infer<typeof baselineEntrySchema>;

const deviceSpecSchema = z.object({
  physical: z.boolean(),
  platform: platformSchema,
  model: z.string(),
  osVersion: z.string(),
  imageTag: imageTagSchema.optional(),
  baseline: z.object({ name: baselineNameSchema, version: z.number().int().min(1) }).optional(),
});

const QUARANTINE_MESSAGE_MAX = 300;

const quarantineCauseSchema = z
  .object({
    kind: z.enum(["purge-failed", "shutdown-failed", "delete-failed", "stalled"]),
    stalledState: z.enum(["provisioning", "reclaiming"]).optional(),
    message: z
      .string()
      .min(1)
      .max(QUARANTINE_MESSAGE_MAX)
      .refine((text) => !/[\p{Cc}\u2028\u2029]/u.test(text))
      .optional(),
  })
  .refine((cause) =>
    cause.kind === "stalled"
      ? cause.stalledState !== undefined && cause.message === undefined
      : cause.stalledState === undefined,
  );

export function quarantineCauseMessage(text: string): string | undefined {
  const cleaned = text.replace(CONTROL_CHARACTERS, " ").trim();
  if (cleaned === "") return undefined;
  if (cleaned.length <= QUARANTINE_MESSAGE_MAX) return cleaned;
  return boundDriverSummary(cleaned, QUARANTINE_MESSAGE_MAX);
}

export const DRIVER_DETAIL_MAX = 1000;

export function boundDriverSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

interface CauseCarrier {
  readonly quarantineCause?: { readonly message?: string | undefined } | undefined;
}

function withoutMessage<T extends CauseCarrier>(device: T): T {
  if (device.quarantineCause?.message === undefined) return device;
  const { message: _message, ...kept } = device.quarantineCause;
  return { ...device, quarantineCause: kept };
}

export function withoutQuarantineMessages<
  S extends {
    readonly devices?: readonly CauseCarrier[] | undefined;
    readonly workers?:
      | readonly { readonly devices?: readonly CauseCarrier[] | undefined }[]
      | undefined;
  },
>(status: S): S {
  return {
    ...status,
    ...(status.devices === undefined ? {} : { devices: status.devices.map(withoutMessage) }),
    ...(status.workers === undefined
      ? {}
      : {
          workers: status.workers.map((worker) =>
            worker.devices === undefined
              ? worker
              : { ...worker, devices: worker.devices.map(withoutMessage) },
          ),
        }),
  };
}

export const deviceRecordSchema = z
  .object({
    id: z.string(),
    driverDeviceId: z.string(),
    spec: deviceSpecSchema,
    state: deviceStateSchema,
    driverData: z.unknown().optional(),
    createdAt: z.number(),
    lastLeaseEndedAt: z.number().optional(),
    foreignStateDetectedAt: z.number().optional(),
    foreignProvenanceDetectedAt: z.number().optional(),
    recoveringSince: z.number().optional(),
    recoveryAttempts: z.number().optional(),
    quarantinedAt: z.number().optional(),
    quarantineAttempts: z.number().optional(),
    quarantineNextRetryAt: z.number().optional(),
    quarantineCause: quarantineCauseSchema.optional(),
    address: z.string().optional(),
    absentReason: absentReasonSchema.optional(),
    physical: z.boolean(),
    mode: deviceModeSchema.optional(),
    class: physicalClassSchema.optional(),
    leaseIdentity: leaseIdentitySchema.optional(),
    transitionAgeMs: z.number().optional(),
    stalled: z.boolean().optional(),
    servesDefaultMode: z.boolean().optional(),
    presence: devicePresenceSchema.optional(),
  })
  .superRefine((device, context) => checkDeviceType(device, context, true));

/**
 * why: `driverDeviceId` is here only for a physical device: its canonical ID is how an operator
 * names it to `device remove`, so every role may see it; a virtual device's driver address is
 * not actionable for a caller that does not hold it, so it is dropped.
 */
export const statusDeviceSchema = z
  .object({
    id: z.string(),
    spec: deviceSpecSchema,
    state: deviceStateSchema,
    physical: z.boolean(),
    mode: deviceModeSchema.optional(),
    class: physicalClassSchema.optional(),
    driverDeviceId: z.string().optional(),
    servesDefaultMode: z.boolean(),
    foreignStateDetectedAt: z.number().optional(),
    foreignProvenanceDetectedAt: z.number().optional(),
    quarantineAttempts: z.number().optional(),
    quarantineNextRetryAt: z.number().optional(),
    quarantineCause: quarantineCauseSchema.optional(),
    absentReason: absentReasonSchema.optional(),
    transitionAgeMs: z.number().optional(),
    stalled: z.boolean().optional(),
    presence: devicePresenceSchema.optional(),
    workerId: z.string().optional(),
  })
  .superRefine((device, context) => checkDeviceType(device, context, true))
  // why: `list.get` records carry a virtual device's driver address, and a worker view parses them
  // through this schema: it drops the address of a device whose canonical ID is not shown.
  .transform((device): typeof device => {
    if (device.physical || device.driverDeviceId === undefined) return device;
    const { driverDeviceId: _address, ...rest } = device;
    return rest;
  });

export const grantedDeviceSchema = z
  .object({
    id: z.string(),
    driverDeviceId: z.string(),
    spec: deviceSpecSchema,
    /**
     * why: The driver-reported address (see `DriverDevice.address`), current as of this device's
     * last `ready` transition. Undefined for a device still `provisioning` (never made ready
     * yet) and for a device that was shut down, which has no address to reach. It becomes
     * defined the next time the device is made ready (`bootForLease`/`readyProvisionedForLease`);
     * nothing here ever guesses at a value it wasn't told.
     */
    address: z.string().optional(),
    physical: z.boolean(),
    mode: deviceModeSchema.optional(),
    class: physicalClassSchema.optional(),
  })
  .superRefine((device, context) => checkDeviceType(device, context, false));
