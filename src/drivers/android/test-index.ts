import {
  ANDROID_SDK_ROOT,
  type BuildProvisioner,
  libraryHarness as libraryHarnessWith,
  createDriver,
  ANDROID_HOME_DIRECTORY,
} from "./testing.js";

export const sdk = ANDROID_SDK_ROOT;

export const home = ANDROID_HOME_DIRECTORY;

export const VIRTUAL_DEVICE = {
  address: "",
  deviceId: "device",
  driverData: {},
  physical: false,
} as const;

/** why: the harnesses the seed tests share with `seeds.test.ts` build whatever makes the seed; here it is the whole driver. */
export const buildDriver: BuildProvisioner = (filesystem, processRunner, options) =>
  createDriver(filesystem, processRunner, options);

export const libraryHarness = (options?: Parameters<typeof libraryHarnessWith>[1]) =>
  libraryHarnessWith(buildDriver, options);
