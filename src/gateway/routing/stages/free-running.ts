/** Free running slots of one capacity entry: `maxRunning - running - reserved`. The free-capacity
 * rank reads it, so a worker that holds an idle warm device ranks as full. */
export function freeRunning(entry: {
  maxRunning: number;
  running: number;
  reserved: number;
}): number {
  return entry.maxRunning - entry.running - entry.reserved;
}

/** Slots the planner could make free for a new device: the free ones, plus every running
 * device that is not leased (`warm`), which it evicts when a running limit blocks it. The
 * free-slot filter reads it, so a worker is kept whenever the planner would serve the request. */
export function freeOrEvictableRunning(entry: {
  maxRunning: number;
  running: number;
  reserved: number;
  warm: number;
}): number {
  return freeRunning(entry) + entry.warm;
}
