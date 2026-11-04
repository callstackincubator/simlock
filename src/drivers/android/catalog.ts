import type { ExactDeviceRequest, VirtualSpec } from "../../core/index.js";
import type { Filesystem, ProcessRunner } from "../../ports/index.js";
import type {
  DeviceProfileSource,
  DeviceProfileSourceDiagnostic,
} from "./device-profile-source.js";
import type { SystemImages } from "./system-images.js";

export interface CatalogOptions {
  readonly avdmanager: string;
  readonly avdmanagerEnv: () => NodeJS.ProcessEnv;
  readonly deviceProfileSources?: readonly DeviceProfileSource[] | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly homeDirectory: string;
  readonly onDiagnostic: ((diagnostic: DeviceProfileSourceDiagnostic) => void) | undefined;
  readonly processRunner: ProcessRunner;
  readonly sdkRoot: string;
  readonly systemImages: Pick<SystemImages, "installedImages" | "noFittingImage">;
}

export class Catalog {
  constructor(_options: CatalogOptions) {}

  async resolveSpec(_request: ExactDeviceRequest): Promise<VirtualSpec> {
    return { model: "", osVersion: "", physical: false, platform: "android" };
  }
}
