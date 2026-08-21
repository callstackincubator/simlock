/**
 * Watches a specific process and notifies once when it exits, so a
 * process-held CLI lease self-terminates instead of surviving reparenting
 * after the agent that launched it dies. See docs/known-pitfalls.md.
 */
export interface ParentWatch {
  /**
   * Starts watching `pid`. Calls `onExit` at most once, the first time the
   * process is observed to be gone.
   */
  watch(pid: number, onExit: () => void): ParentWatchHandle;
}

export interface ParentWatchHandle {
  /** Stops watching. Safe to call more than once, and after `onExit` already fired. */
  stop(): void;
}

// How often NodeParentWatch polls. Fast enough that a crashed agent's holder
// self-terminates promptly; far below anything that would show up as CPU
// noise for a process that otherwise just sits on an idle socket.
const POLL_INTERVAL_MS = 2_000;

/**
 * Polls `process.kill(pid, 0)` for liveness. This is deliberately not the
 * mechanism the project plan calls for -- macOS `kqueue`/`EVFILT_PROC`/
 * `NOTE_EXIT`, Linux `prctl(PR_SET_PDEATHSIG)` -- because neither is
 * reachable from plain Node without a native addon, which this package does
 * not take on. Polling is the real, portable mechanism available today; it
 * satisfies the same `ParentWatch` interface as a future native adapter
 * would, so swapping one in later touches only this file.
 *
 * What polling cannot see, and a native watch could: a pid the OS has since
 * recycled onto an unrelated process reads as alive forever, so that holder
 * falls back to the TTL backstop -- the same net as machine sleep. Erring
 * that way is deliberate; the opposite mistake releases a device out from
 * under an agent that is still working.
 */
export class NodeParentWatch implements ParentWatch {
  constructor(private readonly intervalMs: number = POLL_INTERVAL_MS) {}

  watch(pid: number, onExit: () => void): ParentWatchHandle {
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      if (!isAlive(pid)) {
        stopped = true;
        clearInterval(timer);
        onExit();
      }
    }, this.intervalMs);
    // A pending poll must never be the reason the holder process stays
    // alive -- the daemon connection is what legitimately does that.
    timer.unref();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // ESRCH: no such process -- gone. Anything else (e.g. EPERM signaling a
    // pid we don't own) means it still exists.
    return !isNoSuchProcessError(error);
  }
}

function isNoSuchProcessError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

interface FakeWatchEntry {
  readonly pid: number;
  readonly onExit: () => void;
  stopped: boolean;
}

export class FakeParentWatch implements ParentWatch {
  readonly #entries: FakeWatchEntry[] = [];

  watch(pid: number, onExit: () => void): ParentWatchHandle {
    const entry: FakeWatchEntry = { onExit, pid, stopped: false };
    this.#entries.push(entry);
    return {
      stop: () => {
        entry.stopped = true;
      },
    };
  }

  /** Test hook: simulates `pid` exiting, firing every still-active watcher registered for it. */
  exit(pid: number): void {
    for (const entry of this.#entries) {
      if (entry.pid === pid && !entry.stopped) {
        entry.stopped = true;
        entry.onExit();
      }
    }
  }
}
