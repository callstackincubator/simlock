// Hand-declared rather than imported from src/core/driver.ts, to keep this file free of
// value-level coupling to the src tree and to show the JSON script format at a glance.

export type FakeDriverPlatform = "ios" | "android";

type DeviceClass = "phone" | "tablet" | "watch" | "tv" | "vision" | "auto" | "desktop";

export type FakeDriverOperation =
  | "resolveSpec"
  | "findComponent"
  | "installComponent"
  | "provision"
  | "makeReady"
  | "reclaim"
  | "shutdown"
  | "destroy"
  | "listManaged"
  | "listCatalog"
  | "listComponents"
  | "removeComponent"
  | "revalidateRoot"
  | "inspectPhysical"
  | "listPresentPhysical"
  | "uninstall";

export type FakeDriverEstimateOperation = "provision" | "boot" | "reclaim";

export type FakeDriverErrorSpec =
  | { readonly type: "RuntimeMissingError"; readonly osVersion?: string }
  | { readonly type: "UnknownModelError"; readonly model?: string }
  | { readonly type: "BootTimeoutError"; readonly deviceId?: string }
  | { readonly type: "DriverCrashError"; readonly message?: string }
  | { readonly type: "generic"; readonly message?: string };

export type FakeDriverRefusalReason =
  | "not-connected"
  | "network-only"
  | "untrusted"
  | "developer-mode-off"
  | "os-too-old"
  | "unsupported-kind"
  | "locked"
  | "unreadable"
  | "virtual-device";

export interface ScriptedPhysicalDevice {
  readonly ids: readonly string[];
  readonly model?: string;
  readonly osVersion?: string;
  readonly class?: "phone" | "tablet";
  readonly apps?: readonly string[];
  readonly installedApps?: readonly string[];
  readonly present?: boolean;
  readonly absentReason?: "locked" | "untrusted" | "not-present";
  readonly refusal?: { readonly reason: FakeDriverRefusalReason; readonly message: string };
}

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

export interface ScriptedManagedReality {
  readonly devices?: readonly ScriptedObservedDevice[];
  readonly processes?: readonly ScriptedProcessEntry[];
}

export interface FakeDriverPlatformScript {
  readonly knownModels?: readonly string[];
  readonly availableOsVersions?: readonly string[];
  /**
   * The OS versions this fake can slim. A slim request on one of them resolves to a slim spec,
   * and a prepare boot of a slim-spec device reports `mode: "slim"`. Absent: every request
   * resolves to a full spec and no boot reports a mode, as a driver that does not slim.
   */
  readonly slimmableOsVersions?: readonly string[];
  /**
   * Makes the slim pass fail: a prepare boot of a slim-spec device reports `mode: "full"`, as
   * the iOS driver does when it cannot slim a device it planned to. Needs `slimmableOsVersions`.
   */
  readonly slimPassFails?: boolean;
  /**
   * What `listCatalog` reports a model pairs with. A model left out pairs with every available
   * version, which is also the default for every model.
   */
  readonly modelRuntimes?: Readonly<Record<string, readonly string[]>>;
  /** What `listCatalog` reports as other names per model; none unless set. */
  readonly modelAliases?: Readonly<Record<string, readonly string[]>>;
  /** The built-in preference lists the driver carries, per class; none unless set. */
  readonly defaultModels?: Readonly<Partial<Record<DeviceClass, readonly string[]>>>;
  /** What `listCatalog` reports as each model's class; empty unless set. */
  readonly modelClasses?: Readonly<Record<string, DeviceClass>>;
  /** What `listCatalog` reports as custom models; the field is absent unless set. */
  readonly customModels?: readonly string[];
  /**
   * What `listCatalog` reports as installed images; the field is absent unless set. A request
   * naming an image tag resolves only to a runtime listed here with that tag.
   */
  readonly images?: readonly {
    readonly runtime: string;
    readonly tag: string;
    readonly abi: string;
  }[];
  /** What `toolVersions` reports for `status.get`'s host facts. None by default. */
  readonly toolVersions?: readonly {
    readonly name: string;
    readonly version: string;
    readonly build?: string;
  }[];
  readonly installProgress?: readonly number[];
  readonly componentSizes?: Readonly<Record<string, number>>;
  readonly foreignDevices?: Readonly<Record<string, number>>;
  readonly removalResidue?: string;
  readonly latencyMs?: Partial<Record<FakeDriverOperation, number>>;
  readonly estimateMs?: Partial<Record<FakeDriverEstimateOperation, number>>;
  readonly reclaimResult?: "ready" | "shutdown";
  readonly reclaimStrategy?: "erase" | "snapshot" | "wipe";
  readonly failures?: Partial<Record<FakeDriverOperation, FakeDriverErrorSpec>>;
  readonly managedReality?: ScriptedManagedReality;
  readonly physicalDevices?: readonly ScriptedPhysicalDevice[];
  readonly leaseEnvironment?: Readonly<Record<string, string>>;
  /**
   * Overrides the `address` a `makeReady` boot returns (the script is re-read fresh on every
   * call, so a test can change this between two boots of the same device to simulate the real
   * drivers reassigning it -- e.g. Android's console port on a `shutdown` -> boot cycle).
   * Defaults to `<deviceId>-address`.
   */
  readonly address?: string;
  // why: the browser lane has no simulator to film, so a script names a stand-in program that writes
  // the capture envelope; unset, this platform's screen is unavailable, as on a host whose capture
  // program was never built.
  readonly screenCaptureCommand?: string;
  readonly missingPrerequisites?: readonly {
    readonly prerequisite: string;
    readonly message: string;
    readonly remedy: string;
  }[];
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
/** Comma-separated platforms the fake registers a driver for; unset registers both. */
export const DEFAULT_PLATFORMS_ENV = "SIMLOCK_FAKE_DRIVER_PLATFORMS";
