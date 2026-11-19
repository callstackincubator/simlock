import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";

import type { ProcessRunOptions } from "./process-runner-types.js";

const TASKKILL_TIMEOUT_MS = 10_000;

export function runLimits({
  maxStdoutBytes,
  signal,
}: ProcessRunOptions): Pick<ProcessRunOptions, "maxStdoutBytes" | "signal"> {
  return {
    ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
    ...(signal === undefined ? {} : { signal }),
  };
}

export type WindowsKill = "child" | "children" | "grandchildren" | "tree";

/**
 * why: Windows has no process groups, and a batch file runs under a `cmd.exe` wrapper
 * (`windows-command.ts`): signalling the wrapper alone would leave the script's own processes,
 * `sdkmanager`'s Java, running. `taskkill /T` walks the tree from the wrapper's pid, so it runs
 * while the wrapper is still alive; the wrapper outlives what it runs, since a script runs its
 * commands in the foreground. Windows ends a process on any signal, so `/F` is no harsher than
 * `child.kill`. `taskkill` makes the wrapper exit with a code where `child.kill` reports a
 * signal, so the handle reports the signal it sent instead. Should `taskkill` itself fail, the
 * wrapper alone is killed as before.
 */
function killWindowsProcessTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  runWindowsKill(child, signal, "taskkill", ["/pid", String(pid), "/T", "/F"]);
}

/**
 * why: `killChildren` (`ProcessRunOptions`): the child and the processes it started, never
 * theirs, so `taskkill /T` does not fit. Windows keeps a dead parent's pid in its children's
 * `ParentProcessId`, and pids are reused, so a listed process counts as a child only when it
 * started after the child did. Should PowerShell fail, the child alone is killed.
 */
export function windowsKillScript(pid: number, depth: 1 | 2): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$parent = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $parent) { exit 1 }",
    `$children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Where-Object { $_.CreationDate -ge $parent.CreationDate })`,
    ...(depth === 2
      ? [
          '$grandchildren = @(foreach ($c in $children) { Get-CimInstance Win32_Process -Filter "ParentProcessId = $($c.ProcessId)" | Where-Object { $_.CreationDate -ge $c.CreationDate } })',
        ]
      : ["$grandchildren = @()"]),
    `Stop-Process -Id ${pid} -Force`,
    "foreach ($c in @($children) + @($grandchildren)) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("\n");
}

function killWindowsProcessAndChildren(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
  depth: 1 | 2,
): void {
  const script = windowsKillScript(pid, depth);
  runWindowsKill(child, signal, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
}

function runWindowsKill(
  child: ChildProcess,
  signal: NodeJS.Signals,
  command: string,
  args: readonly string[],
): void {
  const fallback = () => {
    if (isRunning(child)) child.kill(signal);
  };
  const killer = spawnChildProcess(command, args, {
    stdio: "ignore",
    timeout: TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  killer.once("error", fallback);
  killer.once("exit", (code) => {
    if (code !== 0) fallback();
  });
}

/**
 * why: Signals the child's whole process group (children are spawned `detached`, so the group is
 * the unit that actually dies; a `killChildren` child alone), or on Windows a batch file's whole
 * tree, a `killChildren` child with its own children, and any other child alone, treating an
 * already-exited process as success. Extracted so `ProcessHandle` and `StreamingProcessHandle`
 * kill identically -- a timeout that only reached the direct child would leave a tool's own
 * subprocesses running.
 *
 * Guarded on `child.exitCode`/`child.signalCode` -- both still `null` only while the child is
 * actually running -- before ever calling `process.kill(-pid, signal)` directly: that call
 * bypasses `ChildProcess.kill`'s own "already exited" guard, and `wait()` can defer settling
 * up to `EXIT_TO_CLOSE_MAX_DEFERRAL_MS` past the real `exit` event (a chatty grandchild holding
 * stdio open, or a stalled delivery). Node frees a reaped pid for the kernel to recycle, so a
 * timeout firing in that window without this guard could signal a process group the kernel has
 * already handed to someone else -- latent before this PR, but `device.exec` is what makes the
 * timing remotely triggerable.
 */
export function killProcessTree(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
  windowsKill: WindowsKill,
): void {
  if (!isRunning(child)) return;

  if (process.platform === "win32") {
    if (windowsKill === "tree") killWindowsProcessTree(child, pid, signal);
    else if (windowsKill === "children") killWindowsProcessAndChildren(child, pid, signal, 1);
    else if (windowsKill === "grandchildren") killWindowsProcessAndChildren(child, pid, signal, 2);
    else child.kill(signal);
    return;
  }

  // why: a `killChildren` child is signalled alone: the process group also holds what its child
  // started for others to use (the host's one `netsimd`, in the first emulator's group).
  const target = windowsKill === "children" ? pid : -pid;
  try {
    process.kill(target, signal);
  } catch (error: unknown) {
    if (isNoSuchProcessError(error)) {
      return;
    }

    throw error;
  }
}

// why: only a Windows kill is a helper's, so only there the handle reports the signal it sent;
// off Windows a killed child's own exit code stands, as the signal is the kernel's.
export function reportsKillSignal(windowsKill: WindowsKill): boolean {
  return process.platform === "win32" && windowsKill !== "child";
}

// why: a wrapper that already exited, its output still held open by a grandchild, is never
// signalled, so its own exit code stands rather than a kill nobody sent.
export function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function isNoSuchProcessError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
