import { basename } from "node:path";

import type { AdbServerRejectionReason } from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  ProcessRunner,
  ProcessSupervisor,
  TcpProbe,
} from "../../ports/index.js";

/** How long a freshly spawned server gets to accept a connection before it counts as failed. */
const START_TIMEOUT_MS = 10_000;
/** How long a signalled server gets to disappear before the next, harder signal. */
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const IDENTITY_TIMEOUT_MS = 5_000;
/** Ports below this belong to the system, and 5037 is the shared server every tool finds. */
const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const SHARED_ADB_SERVER_PORT = 5037;

/**
 * The scoping this server is started with. Every entry is a containment decision, and
 * three of them are load-bearing enough to state:
 *
 * - `ADB_EMU=0` turns off the emulator scanner. Without it the server sweeps
 *   `DEFAULT_ADB_LOCAL_TRANSPORT_PORT`(5555)..`ADB_LOCAL_TRANSPORT_MAX_PORT` and *connects*
 *   to whatever answers -- the lower bound is hard-coded in adb, so raising the ceiling to
 *   reach Simlock's own console ports would also reach the user's emulators and leave two
 *   servers contending for one device. That is the accident ADR 0001 exists to prevent,
 *   running backwards. Simlock's own emulators still attach because they register
 *   themselves with `host:emulator:<adbPort>` (see `AdbRegistrar`).
 * - `ADB_LOCAL_TRANSPORT_MAX_PORT` stays as belt-and-braces: on an adb build that ignores
 *   `ADB_EMU` it bounds the sweep to Simlock's own console range instead of the user's,
 *   and it costs nothing when the scanner is off.
 * - `ADB_REJECT_KILL_SERVER=1` makes `adb kill-server` refuse -- including for Simlock, which
 *   is why this server is stopped by pid and why its pid is recorded on disk.
 */
const SCOPED_ENVIRONMENT = {
  ADB_EMU: "0",
  ADB_LOCAL_TRANSPORT_MAX_PORT: "5683",
  ADB_MDNS: "0",
  ADB_REJECT_KILL_SERVER: "1",
  ADB_USB: "0",
} as const;

/** What `${SIMLOCK_HOME}/adb-server.json` holds: the only handle on a server that outlives us. */
// fallow-ignore-next-line unused-type -- on-disk contract; documented in docs/known-pitfalls.md and read back by a later daemon.
export interface AdbServerRecord {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
}

export class AdbServerUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: AdbServerRejectionReason,
    readonly port: number,
  ) {
    super(message);
    this.name = "AdbServerUnavailableError";
  }
}

export interface AdbServerSupervisorOptions {
  readonly adbPath: string;
  readonly clock: Clock;
  /**
   * The environment the server is started on top of, injected rather than read from
   * `process.env` here: `ProcessRunner` replaces a child's environment wholesale instead of
   * merging into it, so an adb started from `SCOPED_ENVIRONMENT` alone would lose `PATH`,
   * `HOME`, and `ANDROID_HOME` with it.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly filesystem: Filesystem;
  readonly port: number;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  /** `${SIMLOCK_HOME}/adb-server.json`. */
  readonly recordPath: string;
  readonly tcpProbe: TcpProbe;
}

/**
 * Owns the private adb server Android containment is built on (ADR 0001, decision 4):
 * starts one, adopts the one a previous daemon left behind, and reaps it on shutdown.
 *
 * Every ambiguous case fails closed. Attaching to whatever happens to be listening would
 * silently hand Simlock's emulators to Android Studio's server, which is the guarantee this
 * class exists to make -- and it would do so without producing a single error (safety
 * rule 9).
 */
export class AdbServerSupervisor {
  readonly #options: AdbServerSupervisorOptions;
  #record: AdbServerRecord | undefined;

  constructor(options: AdbServerSupervisorOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    // Before the probe rather than after it: `NodeTcpProbe` answers `false` for a port
    // nothing could listen on, so an out-of-range port would otherwise read as "free" and
    // be handed to a spawn that cannot possibly work.
    this.#requireUsablePort();

    const record = await this.#liveRecord();
    if (await this.#options.tcpProbe.isListening(this.#options.port)) {
      if (record === undefined) {
        throw this.#unavailable(
          "occupied",
          `something is already listening on port ${this.#options.port} and Simlock has no record of starting it`,
        );
      }

      // Adopted: a daemon died, its server did not. The record is the proof of ownership,
      // so it is kept exactly as it was -- rewriting `startedAt` would erase the one hint
      // available for spotting a recycled pid later.
      this.#record = record;
      return;
    }

    if (record !== undefined) {
      // Recorded, alive, and serving nothing: the pid is a leftover rather than a server.
      await this.#reap(record);
    }

    await this.#startServer();
  }

  async stop(): Promise<void> {
    const record = this.#record;
    if (record === undefined) {
      return;
    }

    this.#record = undefined;
    await this.#reap(record);
  }

  #requireUsablePort(): void {
    const { port } = this.#options;

    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw this.#unavailable(
        "invalid-port",
        `${port} is not a usable TCP port (expected an integer between ${MIN_PORT} and ${MAX_PORT})`,
      );
    }

    if (port === SHARED_ADB_SERVER_PORT) {
      // Starting Simlock's server there would either fail or, worse, succeed and become
      // *the* adb server for every tool on the machine.
      throw this.#unavailable(
        "invalid-port",
        `port ${SHARED_ADB_SERVER_PORT} is the shared adb server every other tool uses, so Simlock will not take it over`,
      );
    }
  }

  /**
   * The recorded server, or `undefined` when the record proves nothing. A record that does
   * not parse, names another port, or names a pid nothing answers for is treated as no
   * server at all -- never as something to go and kill.
   */
  async #liveRecord(): Promise<AdbServerRecord | undefined> {
    const record = await this.#readRecord();

    return record !== undefined &&
      record.port === this.#options.port &&
      this.#options.processSupervisor.isAlive(record.pid)
      ? record
      : undefined;
  }

  async #readRecord(): Promise<AdbServerRecord | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.#options.filesystem.readFile(this.#options.recordPath));
    } catch {
      return undefined;
    }

    return isAdbServerRecord(parsed) ? parsed : undefined;
  }

  /**
   * Ends the recorded process, but only once it has proven to be an adb server.
   *
   * A pid alone identifies nothing. After a reboot or heavy pid churn the number in a
   * stale record belongs to somebody else's process, and `isAlive` says "yes" about it just
   * as readily -- so signalling on the strength of the record would eventually SIGKILL a
   * stranger's process on the user's machine. The identity check is repeated before the
   * SIGKILL because the process may have exited and its pid been reused in between.
   */
  async #reap(record: AdbServerRecord): Promise<void> {
    if (!(await this.#isAdbProcess(record.pid))) {
      await this.#forgetRecord();
      return;
    }

    this.#options.processSupervisor.signal(record.pid, "SIGTERM");
    if (!(await this.#waitForExit(record.pid))) {
      if (await this.#isAdbProcess(record.pid)) {
        this.#options.processSupervisor.signal(record.pid, "SIGKILL");
        await this.#waitForExit(record.pid);
      }
    }

    await this.#forgetRecord();
  }

  /**
   * Whether this pid is an adb server, read from the process table. `ps -o comm= -p` prints
   * the command with no arguments and nothing else, and prints nothing at all for a pid
   * that is gone; macOS reports it as a path, Linux as a bare name, so only the basename is
   * comparable. Any failure answers "not adb", which is the fail-closed direction: it costs
   * a leftover server, where the other direction costs somebody else's process.
   */
  async #isAdbProcess(pid: number): Promise<boolean> {
    let result;
    try {
      result = await this.#options.processRunner.run("ps", ["-o", "comm=", "-p", String(pid)], {
        timeoutMs: IDENTITY_TIMEOUT_MS,
      });
    } catch {
      return false;
    }

    if (result.code !== 0) {
      return false;
    }

    const command = result.stdout.split("\n")[0]?.trim() ?? "";
    return command !== "" && basename(command) === "adb";
  }

  async #startServer(): Promise<void> {
    const startedAt = this.#options.clock.now();
    // `nodaemon server` runs the server in the foreground, so the pid recorded below is
    // the server itself. `start-server` would fork one and hand back the pid of a launcher
    // that exits immediately -- a pid that identifies nothing by the time it is needed.
    // `stdio: "ignore"` because this child outlives every call made to it: captured output
    // would accumulate in the handle's buffers for as long as the daemon runs, and there is
    // nothing to read it. Diagnosis happens through the probe and the record instead.
    const handle = this.#options.processRunner.spawn(
      this.#options.adbPath,
      ["-P", String(this.#options.port), "nodaemon", "server"],
      {
        env: {
          ...this.#options.env,
          ...SCOPED_ENVIRONMENT,
          ANDROID_ADB_SERVER_PORT: String(this.#options.port),
        },
        stdio: "ignore",
      },
    );

    if (!(await this.#waitForListening(startedAt))) {
      handle.kill("SIGKILL");
      throw this.#unavailable(
        "start-failed",
        `Simlock's adb server did not start listening on port ${this.#options.port} within ${START_TIMEOUT_MS}ms`,
      );
    }

    const record: AdbServerRecord = { pid: handle.pid, port: this.#options.port, startedAt };
    this.#record = record;
    await this.#options.filesystem.writeFileAtomic(
      this.#options.recordPath,
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  async #waitForListening(startedAt: number): Promise<boolean> {
    while (true) {
      if (await this.#options.tcpProbe.isListening(this.#options.port)) {
        return true;
      }
      if (this.#options.clock.now() - startedAt >= START_TIMEOUT_MS) {
        return false;
      }

      await this.#delay(POLL_INTERVAL_MS);
    }
  }

  async #waitForExit(pid: number): Promise<boolean> {
    const startedAt = this.#options.clock.now();
    while (this.#options.processSupervisor.isAlive(pid)) {
      if (this.#options.clock.now() - startedAt >= STOP_TIMEOUT_MS) {
        return false;
      }

      await this.#delay(POLL_INTERVAL_MS);
    }

    return true;
  }

  async #forgetRecord(): Promise<void> {
    try {
      await this.#options.filesystem.rm(this.#options.recordPath);
    } catch {
      // A record that cannot be removed is a stale file, not a reason to fail a shutdown:
      // the next start re-reads it, finds nothing alive behind it, and drops it then.
    }
  }

  #unavailable(reason: AdbServerRejectionReason, detail: string): AdbServerUnavailableError {
    return new AdbServerUnavailableError(
      `Refusing to run the android driver: ${detail}`,
      reason,
      this.#options.port,
    );
  }

  #delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.#options.clock.setTimer(milliseconds, resolve);
    });
  }
}

function isAdbServerRecord(value: unknown): value is AdbServerRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    Number.isInteger(record["pid"]) &&
    record["pid"] > 0 &&
    typeof record["port"] === "number" &&
    typeof record["startedAt"] === "number"
  );
}
