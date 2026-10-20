import type { HistoryProjectionDefinition } from "../../index.js";
import { createUsageProjector } from "./projector.js";
import { checkUsageTables, USAGE_MIGRATIONS, USAGE_VERSION } from "./schema.js";

export { openUsageReads } from "./reads.js";
export type { DeviceFactRow, MinuteBucket, RequestRow, UsageReads, UsageValue } from "./types.js";

export const USAGE_PROJECTION: HistoryProjectionDefinition = {
  check: checkUsageTables,
  create: createUsageProjector,
  migrations: USAGE_MIGRATIONS,
  name: "usage",
  version: USAGE_VERSION,
};
