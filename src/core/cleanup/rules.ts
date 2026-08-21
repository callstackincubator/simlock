import type { CleanupRule } from "./types.js";
import { idleDestroyRule } from "./idle-destroy.js";
import { idleShutdownRule } from "./idle-shutdown.js";

export const automaticCleanupRules: readonly CleanupRule[] = [idleShutdownRule, idleDestroyRule];
