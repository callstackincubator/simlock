// Shapes shared by the scriptable fake driver, its script file, and its call log.
// These are hand-declared rather than imported from src/core/driver.ts because the
// structural pieces (ObservedDevice, DriverReality, ...) are simple enough to duplicate
// and doing so keeps this file free of any value-level coupling to the src tree beyond
// the four error classes declared in driver-errors.d.ts. Type-only imports would also
// work, but duplicating here makes it obvious at a glance what the JSON script format is.

export type FakeDriverPlatform = "ios" | "android";

export type FakeDriverOperation =
  | "resolveSpec"
  | "provision"
  | "makeReady"
  | "reclaim"
  | "shutdown"
  | "destroy"
  | "listManaged"
  | "listCatalog"
  /** The root re-proof `doctor --purge-orphans` takes before its first destroy. */
  | "revalidateRoot";

export type FakeDriverEstimateOperation = "provision" | "boot" | "reclaim";

/** A forced failure for one operation. `type: "generic"` throws a plain Error. */
export type FakeDriverErrorSpec =
  | { readonly type: "RuntimeMissingError"; readonly osVersion?: string }
  | { readonly type: "UnknownModelError"; readonly model?: string }
  | { readonly type: "BootTimeoutError"; readonly deviceId?: string }
  | { readonly type: "DriverCrashError"; readonly message?: string }
  | { readonly type: "generic"; readonly message?: string };

export type ScriptedRunState = "running" | "stopped" | "transitioning";

export interface ScriptedMark {
  readonly durable?: string;
  readonly erasable?: string;
  readonly erasableReadable?: boolean;
}

export interface ScriptedObservedDevice {
  readonly deviceId: string;
  readonly runState: ScriptedRunState;
  readonly mark?: ScriptedMark;
}

export interface ScriptedProcessEntry {
  readonly deviceId: string;
}

/** Overrides `listManaged()` so doctor drift (unknown/vanished devices) can be staged. */
export interface ScriptedManagedReality {
  readonly devices?: readonly ScriptedObservedDevice[];
  readonly processes?: readonly ScriptedProcessEntry[];
}

export interface FakeDriverPlatformScript {
  readonly knownModels?: readonly string[];
  readonly availableOsVersions?: readonly string[];
  readonly latencyMs?: Partial<Record<FakeDriverOperation, number>>;
  readonly estimateMs?: Partial<Record<FakeDriverEstimateOperation, number>>;
  readonly reclaimResult?: "ready" | "shutdown";
  readonly reclaimStrategy?: "erase" | "snapshot" | "wipe";
  readonly failures?: Partial<Record<FakeDriverOperation, FakeDriverErrorSpec>>;
  readonly managedReality?: ScriptedManagedReality;
  /**
   * Environment the grant for this platform's devices should carry, standing in for the
   * device-set path / adb port a real driver contributes. Read on every operation like
   * everything else here, so a test can set it before the lease it wants to assert on.
   */
  readonly leaseEnvironment?: Readonly<Record<string, string>>;
  /**
   * Overrides the `address` a `makeReady` boot returns (the script is re-read fresh on every
   * call, so a test can change this between two boots of the same device to simulate the real
   * drivers reassigning it -- e.g. Android's console port on a `shutdown` -> boot cycle).
   * Defaults to `<deviceId>-address`.
   */
  readonly address?: string;
}

/** Top-level script file shape, read fresh on every driver operation. */
export interface FakeDriverScript {
  readonly ios?: FakeDriverPlatformScript;
  readonly android?: FakeDriverPlatformScript;
}

export interface FakeDriverLogEntry {
  readonly timestampMs: number;
  readonly platform: FakeDriverPlatform;
  readonly operation: FakeDriverOperation;
  readonly arguments: readonly unknown[];
}

export const DEFAULT_SCRIPT_ENV = "SIMLOCK_FAKE_DRIVER_SCRIPT";
export const DEFAULT_LOG_ENV = "SIMLOCK_FAKE_DRIVER_LOG";
