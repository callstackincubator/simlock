import type { PassthroughCommand } from "../client/index.js";

/**
 * Runs a daemon-resolved `simlock simctl` / `simlock adb` command in this process's own
 * terminal.
 *
 * Inherited stdio, so a passthrough behaves exactly as the bare tool would: `adb shell`
 * stays interactive, `simctl io ... screenshot` writes where it was told to, and nothing
 * is buffered through this process. The scoped environment is layered over the CLI's own
 * rather than replacing it -- it carries only the scoping keys, and a tool spawned without
 * `PATH` or `ANDROID_HOME` would not find the SDK the daemon just pointed it at. The
 * daemon's keys win the merge: a caller with a stale `ANDROID_ADB_SERVER_PORT` already
 * exported would otherwise aim the command at whichever server that names.
 */
export async function spawnPassthrough(command: PassthroughCommand): Promise<number> {
  const { spawn } = await import("node:child_process");
  const { constants } = await import("node:os");
  const child = spawn(command.command, [...command.args], {
    env: { ...process.env, ...command.env },
    stdio: "inherit",
  });
  // why: inherited stdio does not carry a signal sent only to this process; without a
  // forward the CLI dies on SIGINT/SIGTERM and leaves the tool (a recordVideo that still has to
  // flush) running unattended. The CLI stays until the tool's own close decides the exit code.
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const detach = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("close", (code, signal) => {
      detach();
      // A child killed by a signal has no exit code; report it the way a shell does, so a
      // passthrough interrupted with ^C is distinguishable from one that simply failed.
      if (code !== null) resolve(code);
      else resolve(signal === null ? 1 : 128 + (constants.signals[signal] ?? 0));
    });
  });
}
