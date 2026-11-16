import type { z } from "zod";

import type { OPERATIONS } from "../contract/index.js";
import { toDriverDevice, UnknownLeaseError, type PassthroughCommand } from "../core/index.js";
import {
  LeaseFilesError,
  type LeaseFileView,
  type LeaseFiles,
  type LeaseFilesGrant,
} from "../lease-files/index.js";
import {
  exitCodeOf,
  InputStreamFailedError,
  ProcessSpawnError,
  type ProcessRunner,
  type StreamingProcessHandle,
  type StreamingProcessResult,
  type TimerHandle,
} from "../ports/index.js";
import { DispatchError, type DispatchSession } from "./dispatch.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";

/**
 * why: How long a timed-out `device.exec` child gets between SIGTERM and SIGKILL (ADR 0005 §19e).
 * Fixed rather than derived from `exec.timeoutMs`: it is a termination-cleanup budget, not a
 * fraction of the command's own allowance -- the same reasoning, and the same ten seconds, as
 * `NodeProcessRunner`'s `SIGTERM_TO_SIGKILL_GRACE_MS`.
 */
const EXEC_SIGKILL_GRACE_MS = 10_000;

/** why: The `Promise.race` marker for "the timeout won". A unique object rather than a string, so
 * it can never collide with something a `StreamingProcessHandle` could resolve with. */
const EXEC_EXPIRED = Symbol("exec-expired");

export class ExecHandlers {
  constructor(private readonly options: DispatcherOptions) {}

  /**
   * why: Resolution only: the daemon builds the command and never runs it. Spawning it here would
   * attach a user's interactive `adb shell` to the daemon's stdio, and the CLI is the process
   * that actually has a terminal (ADR 0001, decision 7).
   *
   * Both failure modes leave as their own typed errors -- `PassthroughRefusedError` for a verb
   * the driver will not proxy, `UnknownPassthroughToolError` for a tool no driver claims -- so
   * `errorCode` maps them to `PASSTHROUGH_REFUSED` / `UNKNOWN_PASSTHROUGH_TOOL` and
   * `DaemonServer#describeError` still gets the chance to append the driver's refusal summary.
   */
  readonly driverPassthrough: Handler<"driver.passthrough"> = (input) => {
    if (this.options.passthrough === undefined) {
      throw new DispatchError("INTERNAL", "Tool passthrough is unavailable");
    }
    return this.options.passthrough.passthrough(input.tool, undefined, input.args);
  };

  /**
   * why: ADR 0005 §19a: the same command `driver.passthrough` would have handed back, run here
   * instead of there. Everything a passthrough already decides is reused verbatim -- which
   * flag scopes the tool to this daemon's root, which verbs the driver refuses -- because it
   * is the same driver call: `driverPassthrough` above passes no device, this handler passes
   * the lease's device and the lease's platform, and it also spawns the result.
   *
   * `leaseId` is checked against the registry here so an id that names no lease answers
   * `UNKNOWN_LEASE` rather than running a command (`authorize`'s `ownsLease` deliberately lets
   * an unknown id through so this handler can say that -- see `roles.ts`). Which device the
   * command touches is the driver's answer: it fills the lease's device in where the tool
   * expects it and refuses a command that names another (ADR 0047 §1-2); this daemon parses
   * none of the arguments. That is the same accident boundary ADR 0001 draws for the local
   * wrappers, reached over the wire.
   *
   * Nothing is buffered: each chunk goes straight to `session.onOutput` as it arrives (§19e),
   * so a command that writes a gigabyte costs this process nothing, and a client sees the
   * first line while the command is still running.
   */
  readonly deviceExec: Handler<"device.exec"> = async (input, session) => {
    if (this.options.passthrough === undefined) {
      throw new DispatchError("INTERNAL", "Tool passthrough is unavailable");
    }
    const processRunner = this.options.processRunner;
    if (processRunner === undefined) {
      throw new DispatchError("INTERNAL", "Command execution is unavailable");
    }
    // why: checked here, not as a refinement on the shared input, which `.omit()` could no longer build `run_on_device` from.
    if (input.stdin !== undefined && input.stdinFile !== undefined) {
      throw new DispatchError("BAD_REQUEST", "Give stdin or stdinFile, not both");
    }
    const lease = this.options.registry.snapshot.leases.find(
      (candidate) => candidate.id === input.leaseId,
    );
    if (lease === undefined) throw new UnknownLeaseError(input.leaseId);
    const record = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === lease.deviceId,
    );
    if (record === undefined) throw new UnknownLeaseError(input.leaseId);

    // why: `hasTerminal: false` tells the driver its caller has no terminal: the command runs
    // here, with pipes and no pty (ADR 0005 §19c), so a driver may refuse something it allows
    // a local `simlock <tool>` invocation -- a bare `adb shell` would otherwise sit on those
    // pipes until `exec.timeoutMs` killed it. `platform` is the leased device's own.
    const files = this.options.leaseFiles;
    if (files === undefined) throw new DispatchError("INTERNAL", "Lease files are unavailable");
    const command = await this.options.passthrough.passthrough(
      input.tool,
      toDriverDevice(record),
      input.args,
      { hasTerminal: false, platform: record.spec.platform },
    );
    return this.#runExec(
      {
        command,
        files,
        grant: { grantedAt: lease.grantedAt, id: lease.id, platform: record.spec.platform },
        input,
        processRunner,
      },
      session,
    );
  };

  async #runExec(
    run: {
      readonly command: PassthroughCommand;
      readonly files: Pick<LeaseFiles, "folderOf" | "openFile">;
      readonly grant: LeaseFilesGrant;
      readonly input: z.infer<(typeof OPERATIONS)["device.exec"]["input"]>;
      readonly processRunner: ProcessRunner;
    },
    session: DispatchSession,
  ): Promise<{ readonly exitCode: number }> {
    const { command, files, grant, input, processRunner } = run;
    const execEnv: NodeJS.ProcessEnv = { ...this.options.execEnv, ...command.env };
    for (const key of command.unsetEnv ?? []) {
      // why: the base comes from the daemon's environment, so a key it kept could re-aim the command.
      delete execEnv[key];
    }
    const cwd = await this.#folderOf(files, grant);
    const file =
      input.stdinFile === undefined
        ? undefined
        : await this.#openStdinFile(files, grant, input.stdinFile);
    try {
      const handle = processRunner.spawnStreaming(command.command, command.args, {
        cwd,
        env: execEnv,
        // why: Returned, not fired and forgotten: whatever the transport hands back is what pauses
        // the child until the chunk has actually gone somewhere (ADR 0005 §19e).
        onChunk: (stream, chunk) => session.onOutput?.(stream, chunk),
        ...(input.stdin === undefined ? {} : { input: input.stdin }),
        ...(file === undefined ? {} : { inputStream: file.read() }),
      });
      // why: Announced before the first chunk can arrive, because "it started" is what a transport
      // needs to decide its response shape on -- see `DispatchSession.onStarted`.
      session.onStarted?.();
      return {
        exitCode: await this.#awaitExec(handle, input.tool, input.args, input.stdinFile),
      };
    } catch (error) {
      if (error instanceof ProcessSpawnError) {
        // why: Node reports no reason for a start that failed, so the folder is asked again: a lease that ended after `folderOf` made the working folder vanish (404), anything else is the spawn's own failure.
        await this.#folderOf(files, grant);
      }
      throw error;
    } finally {
      await file?.close();
    }
  }

  async #folderOf(files: Pick<LeaseFiles, "folderOf">, grant: LeaseFilesGrant): Promise<string> {
    try {
      return await files.folderOf(grant);
    } catch (error) {
      if (error instanceof LeaseFilesError) {
        throw new DispatchError(error.code, error.message, error.details);
      }
      throw error;
    }
  }

  async #openStdinFile(
    files: Pick<LeaseFiles, "openFile">,
    grant: LeaseFilesGrant,
    name: string,
  ): Promise<LeaseFileView> {
    try {
      return await files.openFile(grant, name);
    } catch (error) {
      if (error instanceof LeaseFilesError) {
        throw new DispatchError(error.code, error.message, error.details);
      }
      // why: the file was listed and then deleted before the open, so it is gone, not a failure of the daemon.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DispatchError("UNKNOWN_FILE", `No file ${name} in this lease`, { name });
      }
      throw error;
    }
  }

  async #awaitExec(
    handle: StreamingProcessHandle,
    tool: string,
    args: readonly string[],
    stdinFile: string | undefined,
  ): Promise<number> {
    const timeoutMs = this.options.config.exec.timeoutMs;
    const waited = handle.wait();
    // why: `inputFailed` only ever rejects, so the race below hears it as a value and never as a second way for the command to finish.
    const inputFailed = handle.inputFailed?.catch((error: unknown) => error);
    let timer: TimerHandle | undefined;
    const expired = new Promise<typeof EXEC_EXPIRED>((resolve) => {
      timer = this.options.clock.setTimer(timeoutMs, () => resolve(EXEC_EXPIRED));
    });
    let killTimer: TimerHandle | undefined;
    try {
      // why: Raced rather than decided by a flag the timer sets: a command that exits in the same
      // turn the timer fires has *finished*, and reporting that as a timeout would blame the
      // limit for a command that met it. `Promise.race` settles on whichever actually
      // happened first, which is exactly the question.
      const outcome = await Promise.race([
        waited,
        expired,
        ...(inputFailed === undefined ? [] : [inputFailed]),
      ]);
      if (outcome !== EXEC_EXPIRED && !(outcome instanceof InputStreamFailedError)) {
        return exitCodeOf(outcome as StreamingProcessResult);
      }

      // why: SIGTERM first, SIGKILL after a grace window: a tool that ignores the first must not be
      // able to hold this operation -- and the caller's connection -- open forever. The same
      // escalation `NodeProcessRunner#run` makes for its own timeout.
      killQuietly(handle, "SIGTERM");
      killTimer = this.options.clock.setTimer(EXEC_SIGKILL_GRACE_MS, () => {
        killQuietly(handle, "SIGKILL");
      });
      // why: Once the kill is issued, the timeout is the authoritative fact (ADR 0005 §19e) --
      // `waited` rejecting with `ExecOutputDeliveryStalledError` (a consumer that stopped
      // reading is *why* the command outran its timeout in the first place: the pause that
      // stops it finishing is the same pause that stalls delivery) is a consequence of the
      // timeout, not a competing answer to it. Swallowed here rather than left to reject
      // this `await` and skip the throw below.
      await waited.catch(() => undefined);
      if (outcome instanceof InputStreamFailedError && stdinFile !== undefined) {
        throw new DispatchError(
          "STDIN_FILE_FAILED",
          `Reading ${stdinFile} failed after ${String(outcome.bytesWritten)} bytes; the command was stopped`,
          { bytesRead: outcome.bytesWritten, name: stdinFile },
        );
      }
      // why: `EXEC_TIMEOUT` rather than the exit code the kill produced: "we stopped it" and "it
      // failed" are different facts, and only the first tells a caller to raise the limit.
      throw new DispatchError(
        "EXEC_TIMEOUT",
        `\`${tool} ${args.join(" ")}\` exceeded exec.timeoutMs (${String(timeoutMs)}ms) and was killed`,
      );
    } finally {
      if (timer !== undefined) this.options.clock.cancel(timer);
      if (killTimer !== undefined) this.options.clock.cancel(killTimer);
    }
  }
}

/** why: A child that exited between the timer firing and the signal landing is not an error worth
 * failing the operation over -- the wait below is about to report how it ended anyway. */
function killQuietly(handle: StreamingProcessHandle, signal: NodeJS.Signals): void {
  try {
    handle.kill(signal);
  } catch {
    // Already gone.
  }
}
