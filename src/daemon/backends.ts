import {
  UnknownBackendError,
  type BackendModule,
  type Config,
  type Platform,
} from "../core/index.js";
import { androidLocalBackend } from "../drivers/android/local/index.js";
import { iosLocalBackend } from "../drivers/ios/local/index.js";

export const backendModules: readonly BackendModule<unknown, unknown>[] = [
  androidLocalBackend,
  iosLocalBackend,
];

export function selectedBackend(
  platform: Platform,
  drivers: Config["drivers"],
): BackendModule<unknown, unknown> {
  const id = drivers[platform]?.backend ?? "local";
  const found = backendModules.find(
    (backend) => backend.definition.platform === platform && backend.definition.id === id,
  );
  if (found !== undefined) return found;
  const available = backendModules.filter((backend) => backend.definition.platform === platform);
  const ids = available.map((backend) => backend.definition.id);
  const selectedId = String(id);
  throw new UnknownBackendError(platform, selectedId, ids);
}
