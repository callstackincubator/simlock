import { z } from "zod";

const nonEmptyString = z.string().min(1);
const finiteNumber = z.number().finite();
export const MAX_TIMEOUT_SECONDS = Number.MAX_SAFE_INTEGER / 1_000;

export const leaseSimulatorInputSchema = z.object({
  allow_download: z.boolean().default(false),
  device: nonEmptyString,
  no_wait: z.boolean().default(false),
  os: nonEmptyString.optional(),
  platform: z.enum(["ios", "android"]),
  timeout_seconds: finiteNumber
    .nonnegative()
    .max(MAX_TIMEOUT_SECONDS, "timeout_seconds is too large to convert safely to milliseconds")
    .optional(),
});

export const leaseSimulatorOutputSchema = z.object({
  device: nonEmptyString,
  device_id: nonEmptyString,
  expires_at_ms: finiteNumber,
  lease_id: nonEmptyString,
  mode: z.literal("held"),
  os: nonEmptyString,
  platform: z.enum(["ios", "android"]),
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

export type LeaseSimulatorInput = z.infer<typeof leaseSimulatorInputSchema>;
export type LeaseSimulatorOutput = z.infer<typeof leaseSimulatorOutputSchema>;
export type ReleaseSimulatorInput = z.infer<typeof releaseSimulatorInputSchema>;
export type ReleaseSimulatorOutput = z.infer<typeof releaseSimulatorOutputSchema>;
export type ListDevicesInput = z.infer<typeof listDevicesInputSchema>;
export type ListDevicesOutput = z.infer<typeof listDevicesOutputSchema>;
