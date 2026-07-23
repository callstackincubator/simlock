import { z } from "zod";

const nonEmptyString = z.string().min(1);
const finiteNumber = z.number().finite();

export const leaseSimulatorInputSchema = z.object({
  allow_download: z.boolean().default(false),
  device: nonEmptyString,
  no_wait: z.boolean().default(false),
  os: nonEmptyString.optional(),
  platform: z.enum(["ios", "android"]),
  timeout_seconds: finiteNumber.nonnegative().optional(),
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

export type LeaseSimulatorInput = z.infer<typeof leaseSimulatorInputSchema>;
export type LeaseSimulatorOutput = z.infer<typeof leaseSimulatorOutputSchema>;
export type ReleaseSimulatorInput = z.infer<typeof releaseSimulatorInputSchema>;
export type ReleaseSimulatorOutput = z.infer<typeof releaseSimulatorOutputSchema>;
