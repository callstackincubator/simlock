/** Free running slots of one capacity entry: `maxRunning - running - reserved`. The one place
 * the free-slot filter and the free-capacity rank both read it, so they cannot disagree. */
export function freeRunning(entry: {
  maxRunning: number;
  running: number;
  reserved: number;
}): number {
  return entry.maxRunning - entry.running - entry.reserved;
}
