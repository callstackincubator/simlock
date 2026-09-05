import type { AdbServerRejectionReason } from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  ProcessHandle,
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
 * - `ADB_LOCAL_TRANSPORT_MAX_PORT` is *not* a bound on the damage, and reading it that way
 *   gets it backwards: the sweep starts at the hard-coded 5555, so on a build that ignores
 *   `ADB_EMU` the user's emulators are reached at the default ceiling of 5585 already, and
 *   5683 only extends the sweep upwards over Simlock's own consoles (5586-5682). That is
 *   what it is for -- on such a build it is the only thing that makes Simlock's own
 *   emulators discoverable and re-attachable by the scanner that cannot be turned off.
 *   Where `ADB_EMU=0` is honoured it does nothing at all, in either direction.
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
  /**
   * When this server was started, for a human reading the file or a bug report. Nothing
   * decides anything from it, deliberately: identity is proven from the process's command
   * line (`#identify`), and a timestamp compared against this daemon's own boot time would
   * call every correctly adopted server stale, since an adopted one always predates it.
   */
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
        // The one state with no automatic way out, so the message is the recovery
        // documentation: `adb kill-server` is refused by design and the record file that
        // would have carried the pid is not there, which leaves the port and a human.
        throw this.#unavailable(
          "occupied",
          `something is already listening on port ${this.#options.port} and Simlock has no record of starting it, so it will not attach to it. ` +
            `Either stop that server (\`lsof -nP -iTCP:${this.#options.port} -sTCP:LISTEN\` names the pid; \`adb kill-server\` will not work) ` +
            `or move Simlock's own with \`simlock config set drivers.android.adbServerPort <port>\``,
        );
      }

      // Adopted: a daemon died, its server did not. The record is kept byte for byte --
      // it is what a later reap identifies this server by, and rewriting it here would
      // replace a fact about the server with a fact about this daemon.
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
   * Ends the recorded process, but only once it has proven to be *this* server.
   *
   * A pid alone identifies nothing. After a reboot or heavy pid churn the number in a
   * stale record belongs to somebody else's process, and `isAlive` says "yes" about it just
   * as readily -- so signalling on the strength of the record would eventually SIGKILL a
   * stranger's process on the user's machine. The identity check is repeated before the
   * SIGKILL because the process may have exited and its pid been reused in between.
   *
   * An inconclusive check keeps the record. The other direction looks tidier and is worse:
   * the record is the only handle anything has on a server that refuses `adb kill-server`,
   * and a start that finds the port listening with no record has nowhere left to go but
   * `occupied` -- so deleting a record Simlock could not read the process table for would
   * disable Android on that host until somebody found the pid by hand.
   */
  async #reap(record: AdbServerRecord): Promise<void> {
    const identity = await this.#identify(record.pid);
    if (identity === "unknown") {
      return;
    }
    if (identity === "other") {
      await this.#forgetRecord();
      return;
    }

    this.#options.processSupervisor.signal(record.pid, "SIGTERM");
    if (!(await this.#waitForExit(record.pid))) {
      if ((await this.#identify(record.pid)) === "own-server") {
        this.#options.processSupervisor.signal(record.pid, "SIGKILL");
        await this.#waitForExit(record.pid);
      }
    }

    await this.#forgetRecord();
  }

  /**
   * What the process table says this pid is, read as a full command line.
   *
   * `-o comm=` would be the obvious flag and is the wrong one: it strips the arguments,
   * which are the only thing that separates Simlock's server from the machine's shared one.
   * "Some adb" is exactly the population a recycled pid is most likely to land in on a
   * developer's machine, and signalling on that evidence would SIGKILL the adb server
   * Android Studio and every other tool are sharing. `-o args=` (`command` on some BSD
   * `ps`) keeps them, so ownership can be required rather than assumed: an adb binary, the
   * `-P <port>` this supervisor configured, and `nodaemon`.
   *
   * The three answers are deliberately distinct, and only a command line that was actually
   * read counts as `"other"` -- the stale record to drop. Everything else is `"unknown"`,
   * where the record must survive (see `#reap`): a `ps` that is missing, not on `PATH`, too
   * slow, or too small to know `-o args=` (BusyBox) all report as failures indistinguishable
   * from "no such pid", and guessing "gone" from an exit code would delete the record on
   * every shutdown on such a host.
   */
  async #identify(pid: number): Promise<"own-server" | "other" | "unknown"> {
    let result;
    try {
      result = await this.#options.processRunner.run("ps", ["-o", "args=", "-p", String(pid)], {
        timeoutMs: IDENTITY_TIMEOUT_MS,
      });
    } catch {
      return "unknown";
    }

    if (result.code !== 0) {
      return "unknown";
    }

    const commandLine = result.stdout.split("\n")[0]?.trim() ?? "";
    if (commandLine === "") {
      return "unknown";
    }

    return this.#isOwnServerCommand(commandLine) ? "own-server" : "other";
  }

  /**
   * Matched on the raw line rather than on split arguments because an SDK path may contain
   * spaces, and `ps` gives no way to tell those apart from argument separators.
   */
  #isOwnServerCommand(commandLine: string): boolean {
    return (
      /(?:^|[\s/])adb(?:\.exe)?(?=\s)/.test(commandLine) &&
      new RegExp(`(?:^|\\s)-P\\s+${this.#options.port}(?=\\s|$)`).test(commandLine) &&
      /(?:^|\s)nodaemon(?=\s|$)/.test(commandLine)
    );
  }

  async #startServer(): Promise<void> {
    const startedAt = this.#options.clock.now();
    // `nodaemon server` runs the server in the foreground, so the pid recorded below is
    // the server itself. `start-server` would fork one and hand back the pid of a launcher
    // that exits immediately -- a pid that identifies nothing by the time it is needed.
    // `stdio: "ignore"` because this child outlives every call made to it: captured output
    // would accumulate in the handle's buffers for as long as the daemon runs, and there is
    // nothing to read it. Diagnosis happens through the probe and the record instead.
    let handle;
    try {
      handle = this.#options.processRunner.spawn(
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
    } catch (error: unknown) {
      // An `adb` that exists but cannot be executed is an Android configuration problem and
      // must cost Android alone; letting it out untyped would take the daemon, and iOS with
      // it, down over it.
      throw this.#unavailable(
        "start-failed",
        `Simlock could not start an adb server from ${this.#options.adbPath}: ${messageOf(error)}`,
      );
    }

    // This child is meant to outlive the daemon: it is reaped by pid, never awaited, and
    // `nodaemon server` never exits on its own. Left referenced it would hold the event
    // loop open forever, so a daemon that failed anywhere below would hang instead of
    // exiting.
    handle.unref();

    const record: AdbServerRecord = { pid: handle.pid, port: this.#options.port, startedAt };
    // Written before the wait, not after it: everything between the spawn and a listening
    // port is a window in which this daemon can die, and without a record on disk the next
    // one finds a listening port it has no claim on, answers `occupied`, and leaves Android
    // dead until a human finds the pid.
    try {
      await this.#options.filesystem.writeFileAtomic(
        this.#options.recordPath,
        `${JSON.stringify(record, null, 2)}\n`,
      );
    } catch (error: unknown) {
      // A server nothing can record is a server nothing can reap, so it is killed here
      // rather than left running on the port the next start will need.
      await this.#abandon(handle);
      throw this.#unavailable(
        "start-failed",
        `Simlock started an adb server on port ${this.#options.port} but could not record it at ${this.#options.recordPath}: ${messageOf(error)}`,
      );
    }
    this.#record = record;

    if (!(await this.#waitForListening(startedAt, handle.pid))) {
      this.#record = undefined;
      await this.#abandon(handle);
      throw this.#unavailable(
        "start-failed",
        `Simlock's adb server did not start listening on port ${this.#options.port} within ${START_TIMEOUT_MS}ms`,
      );
    }
  }

  /**
   * Kills a server this start is giving up on, and drops its record only once the process
   * is confirmed gone -- while it might still be alive the record is the only handle
   * anything has on it. A record that has since stopped naming this pid belongs to somebody
   * else's server and is left where it is, for the same reason.
   */
  async #abandon(handle: ProcessHandle): Promise<void> {
    handle.kill("SIGKILL");
    if (!(await this.#waitForExit(handle.pid))) {
      return;
    }

    if ((await this.#readRecord())?.pid === handle.pid) {
      await this.#forgetRecord();
    }
  }

  async #waitForListening(startedAt: number, pid: number): Promise<boolean> {
    while (true) {
      const listening = await this.#options.tcpProbe.isListening(this.#options.port);
      // A loopback connect proves something is serving the port, not that it is the child
      // just spawned. Two daemons cold-starting on one port both probe it free and both
      // spawn; one binds, the other prints "cannot bind" and exits. Without this the loser
      // reads the winner's server as its own success and writes a record naming its own
      // dead pid over the winner's -- which is also how a foreign server gets adopted when
      // two Simlock homes share a port (safety rule 9).
      if (!this.#options.processSupervisor.isAlive(pid)) {
        return false;
      }
      if (listening) {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
