import { z } from "zod";

const nonEmptyString = z.string().min(1);
const finiteNumber = z.number().finite();
export const MAX_TIMEOUT_SECONDS = Number.MAX_SAFE_INTEGER / 1_000;

export const leaseSimulatorInputSchema = z.object({
  allow_download: z.boolean().default(false),
  device: nonEmptyString,
  // Platform-neutral: "give me a device with no driver-side resource reduction". The iOS
  // driver implements this as "do not slim"; other drivers ignore it.
  full: z.boolean().default(false),
  no_wait: z.boolean().default(false),
  os: nonEmptyString.optional(),
  platform: z.enum(["ios", "android"]),
  timeout_seconds: finiteNumber
    .nonnegative()
    .max(MAX_TIMEOUT_SECONDS, "timeout_seconds is too large to convert safely to milliseconds")
    .optional(),
});

export const leaseSimulatorOutputSchema = z.object({
  // Optional: undefined only for a device leased straight out of a pre-address `state.json`
  // without ever rebooting under this daemon -- see `DeviceRecord.address` in domain.ts.
  address: nonEmptyString.optional(),
  device: nonEmptyString,
  device_id: nonEmptyString,
  expires_at_ms: finiteNumber,
  lease_id: nonEmptyString,
  mode: z.literal("held"),
  os: nonEmptyString,
  platform: z.enum(["ios", "android"]),
  /** Whether the granted device had its feature set reduced -- see `RawLeaseGrant.slim`. */
  slim: z.boolean(),
  state: z.literal("leased"),
  timing: z.object({
    estimated_boot_ms: finiteNumber,
    estimated_provision_ms: finiteNumber,
    estimated_reclaim_ms: finiteNumber,
    estimated_ready_ms: finiteNumber,
  }),
});

export const releaseSimulatorInputSchema = z.object({
  lease_id: nonEmptyString,
});

export const releaseSimulatorOutputSchema = z.object({
  lease_id: nonEmptyString,
  released: z.literal(true),
});

export const listDevicesInputSchema = z.object({
  platform: z.enum(["ios", "android"]).optional(),
});

export const listDevicesOutputSchema = z.object({
  platforms: z.array(
    z.object({
      default_runtime: nonEmptyString.optional(),
      models: z.array(nonEmptyString),
      platform: z.enum(["ios", "android"]),
      runtimes: z.array(nonEmptyString),
    }),
  ),
});

export const leaseStatusInputSchema = z.object({});

// Flat and all-optional (rather than a discriminated union) because the MCP SDK
// validates structuredContent against outputSchema as a plain object shape.
export const leaseStatusOutputSchema = z.object({
  device: nonEmptyString.optional(),
  device_id: nonEmptyString.optional(),
  expires_at_ms: finiteNumber.optional(),
  held: z.boolean(),
  lease_id: nonEmptyString.optional(),
  os: nonEmptyString.optional(),
  platform: z.enum(["ios", "android"]).optional(),
  state: z.literal("leased").optional(),
});

export type LeaseSimulatorInput = z.infer<typeof leaseSimulatorInputSchema>;
export type LeaseSimulatorOutput = z.infer<typeof leaseSimulatorOutputSchema>;
export type ReleaseSimulatorInput = z.infer<typeof releaseSimulatorInputSchema>;
export type ReleaseSimulatorOutput = z.infer<typeof releaseSimulatorOutputSchema>;
export type ListDevicesInput = z.infer<typeof listDevicesInputSchema>;
export type ListDevicesOutput = z.infer<typeof listDevicesOutputSchema>;
export type LeaseStatusOutput = z.infer<typeof leaseStatusOutputSchema>;

/** The `lease_status` result when this session currently holds a lease. */
export interface HeldLeaseStatus {
  readonly device: string;
  readonly device_id: string;
  readonly expires_at_ms: number;
  readonly held: true;
  readonly lease_id: string;
  readonly os: string;
  readonly platform: "android" | "ios";
  readonly state: "leased";
}

/** The `lease_status` result when this session holds nothing. */
export interface NoLeaseStatus {
  readonly held: false;
}
