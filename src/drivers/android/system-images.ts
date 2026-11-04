import {
  LicenseNotAcceptedError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  type DriverComponent,
  type DriverToolVersion,
  type InstalledComponent,
} from "../../core/index.js";
import type { Clock, Filesystem, ProcessRunner } from "../../ports/index.js";
import type { AndroidSdkPaths } from "./sdk-paths.js";

export class AndroidLicenseNotAcceptedError extends LicenseNotAcceptedError {
  constructor(readonly packageName: string) {
    super("android", packageName);
    this.message =
      `sdkmanager refused to install ${packageName}: an Android SDK license is not accepted. ` +
      `Set "downloads.acceptAndroidLicenses": true in config to accept automatically, or run ` +
      `\`sdkmanager --licenses\` manually.`;
    this.name = "AndroidLicenseNotAcceptedError";
  }
}

export interface SystemImagesOptions {
  readonly acceptAndroidLicenses: boolean;
  readonly clock: Clock;
  readonly deviceRoot: string;
  readonly filesystem: Filesystem;
  readonly hostAbi: string;
  readonly legacyAvdHome: string;
  readonly processRunner: ProcessRunner;
  readonly sdk: Pick<AndroidSdkPaths, "adb" | "emulator" | "root" | "sdkmanager">;
}

export class SystemImages {
  constructor(_options: SystemImagesOptions) {}

  toolVersions(): Promise<readonly DriverToolVersion[]> {
    return Promise.resolve([]);
  }

  findComponent(_component: string): Promise<InstalledComponent | undefined> {
    return Promise.resolve(undefined);
  }

  installComponent(
    _component: string,
    _options: {
      readonly onProgress: (progress: ComponentInstallProgress) => void;
      readonly signal: AbortSignal;
    },
  ): Promise<ComponentInstallResult> {
    return Promise.resolve({
      outcome: "installed",
      receipt: { package: "", revision: "", stamp: "" },
      version: "",
    });
  }

  listComponents(): Promise<readonly DriverComponent[]> {
    return Promise.resolve([]);
  }
}
