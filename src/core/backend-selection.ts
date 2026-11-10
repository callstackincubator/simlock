import type { BackendDefinition, BackendSettings } from "./backend.js";
import type { Platform } from "./domain.js";
import { ConfigError } from "./validation.js";

export class UnknownBackendError extends ConfigError {
  constructor(platform: Platform, id: string, available: readonly string[]) {
    const choices = available.join(", ");
    super(`Unknown ${platform} backend "${id}"; available backends: ${choices}`);
    this.name = "UnknownBackendError";
  }
}

export function selectedBackendDefinition(
  definitions: readonly BackendDefinition<unknown>[],
  platform: Platform,
  settings: BackendSettings,
): BackendDefinition<unknown> {
  const id = settings["backend"] ?? "local";
  const candidates = definitions.filter((definition) => definition.platform === platform);
  const found = candidates.find((definition) => definition.id === id);
  if (found === undefined) {
    const ids = candidates.map((definition) => definition.id);
    const selectedId = String(id);
    throw new UnknownBackendError(platform, selectedId, ids);
  }
  return found;
}
