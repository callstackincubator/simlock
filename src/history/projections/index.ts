import type { HistoryProjectionDefinition } from "../index.js";
import { USAGE_PROJECTION } from "./usage/index.js";

export { openUsageReads } from "./usage/index.js";
export type { DeviceFactRow, MinuteBucket, RequestRow } from "./usage/index.js";

export const HISTORY_PROJECTIONS: Readonly<Record<string, HistoryProjectionDefinition>> = {
  usage: USAGE_PROJECTION,
};
