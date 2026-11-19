import {
  type DeviceRecord,
  type DeviceSpec,
  type Driver,
  type LeaseTiming,
  toDriverDevice,
} from "../core/index.js";

export function estimatedTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedProvisionMs = driver.estimate({ operation: "provision" }, spec);
  const estimatedBootMs = driver.estimate({ operation: "boot" }, spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: estimatedProvisionMs + estimatedBootMs,
  };
}

export async function estimatedBootTiming(
  driver: Driver,
  device: DeviceRecord,
): Promise<LeaseTiming> {
  const spec = device.spec;
  // why: The quote is advisory. A driver that cannot read the device's own boot path (a failed
  // `emulator -version`, say) must not strand the claim and capacity reservation that the boot
  // below releases, so the device-less figure stands in.
  const estimatedBootMs = await Promise.resolve(
    driver.estimate(
      { device: toDriverDevice(device), operation: "boot", purpose: "prepare" },
      spec,
    ),
  ).catch(() => driver.estimate({ operation: "boot" }, spec));
  return {
    estimatedBootMs,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: estimatedBootMs,
  };
}

/** why: a device that is already ready costs nothing to hand over; only its reclaim lies ahead. */
export function grantReadyTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  return {
    estimatedBootMs: 0,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: 0,
  };
}

/** why: `standard`: every release path asks for it; a holder cannot request another clean level. */
export function releaseReclaimEstimateMs(driver: Driver, spec: DeviceSpec): number {
  return driver.estimate({ clean: "standard", operation: "reclaim" }, spec);
}
