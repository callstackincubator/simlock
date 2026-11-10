import type { Platform } from "./domain.js";

export function backendKey(platform: Platform, backend: string): string {
  return `${platform}:${backend}`;
}
