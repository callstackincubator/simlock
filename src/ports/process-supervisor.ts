/**
 * Liveness and signalling for a process addressed by pid rather than by a handle.
 *
 * `ProcessRunner` covers processes this daemon spawned and still holds; this port covers
 * the ones it does not: a supervised child recorded on disk outlives the daemon that
 * started it, so after a crash the only thing left to ask about it is its pid.
 */
export interface ProcessSupervisor {
  /** True when a process with this pid exists and this user may signal it. */
  isAlive(pid: number): boolean;
  /** Best effort; a pid that is already gone is not an error. */
  signal(pid: number, signal: NodeJS.Signals): void;
}

export class NodeProcessSupervisor implements ProcessSupervisor {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // Both ESRCH (gone) and EPERM (alive, but another user's) answer "no" here, and
      // deliberately so: this port exists to decide whether a recorded pid is a process
      // this daemon can still reap. One it may not signal is not that, whatever it is --
      // and reporting it alive would leave the caller waiting on a kill that can never
      // land.
      return false;
    }
  }

  // fallow-ignore-next-line unused-class-member -- ProcessSupervisor contract; the reaping side of it.
  signal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      if (isNoSuchProcessError(error)) {
        return;
      }

      throw error;
    }
  }
}

export interface SignalRecord {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
}

/**
 * Records signals instead of sending them, and lets a test decide which pids are alive.
 * Signalling deliberately does not kill anything here: whether a process dies on SIGTERM,
 * ignores it, or dies only on SIGKILL is exactly what the supervision code under test has
 * to cope with, so the test says which of those happened.
 */
export class FakeProcessSupervisor implements ProcessSupervisor {
  readonly signals: SignalRecord[] = [];
  readonly #live = new Set<number>();

  constructor(livePids: readonly number[] = []) {
    for (const pid of livePids) {
      this.#live.add(pid);
    }
  }

  isAlive(pid: number): boolean {
    return this.#live.has(pid);
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
  }

  markAlive(pid: number): void {
    this.#live.add(pid);
  }

  markDead(pid: number): void {
    this.#live.delete(pid);
  }
}

function isNoSuchProcessError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
