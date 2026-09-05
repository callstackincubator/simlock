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
    if (!isAddressablePid(pid)) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      // Both ESRCH (gone) and EPERM (alive, but another user's) answer "no" here, and
      // deliberately so: this port exists to decide whether a recorded pid is a process
      // this daemon can still reap. One it may not signal is not that, whatever it is --
      // and reporting it alive would leave the caller waiting on a kill that can never
      // land. Anything else is a bug rather than an answer about a process, and reporting
      // it as "not alive" would hide it behind a plausible-looking result.
      if (isFailureWithCode(error, NOT_ALIVE_CODES)) {
        return false;
      }

      throw error;
    }
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    if (!isAddressablePid(pid)) {
      return;
    }

    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      if (isFailureWithCode(error, NO_SUCH_PROCESS_CODES)) {
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

/** The pid is gone, or belongs to a user this process may not signal. */
const NOT_ALIVE_CODES = new Set(["ESRCH", "EPERM"]);

const NO_SUCH_PROCESS_CODES = new Set(["ESRCH"]);

/** `process.kill` refuses anything outside a signed 32-bit integer with a `RangeError`. */
const MAX_PID = 2 ** 31 - 1;

/**
 * Whether this number addresses one process at all. `process.kill` reads `0` as "every
 * process in my group" and a negative pid as a whole group -- `-1` as every process this
 * user may signal -- so a pid read back from a corrupt record on disk could turn a
 * routine `SIGKILL` of a stale child into the end of the user's login session. Guarding
 * here rather than in each caller is the point: this port is the primitive they all pass
 * through (safety rule 1).
 */
function isAddressablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

function isFailureWithCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.has(error.code)
  );
}
