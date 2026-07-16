import type { CleanupRule } from "./types.js";
import { idleDestroyRule } from "./idle-destroy.js";
import { idleShutdownRule } from "./idle-shutdown.js";
import { runtimeGcRule } from "./runtime-gc.js";

export const automaticCleanupRules: readonly CleanupRule[] = [idleShutdownRule, idleDestroyRule];
export const manualCleanupRules: readonly CleanupRule[] = [runtimeGcRule];
