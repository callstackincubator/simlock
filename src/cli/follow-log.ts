import {
  isMissingPathError,
  type Clock,
  type Filesystem,
  type TimerHandle,
} from "../ports/index.js";

export interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface FollowLogOptions {
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  /** The current log file; its one rotated generation is `<path>.1`. */
  readonly path: string;
  readonly signals: Signals;
  readonly write: (text: string) => void;
  readonly intervalMs?: number;
  readonly tailLines?: number;
}

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_TAIL_LINES = 100;
/** Retries of the initial tail when a rotation keeps landing mid-read; past it, the last read
 * is used as it is. */
const MAX_TAIL_ATTEMPTS = 3;

/**
 * `simlock daemon logs --follow`: prints the last lines of the log, then each new complete line
 * as it is written, until `SIGINT` or `SIGTERM`. Polls through the `Filesystem` and `Clock`
 * ports rather than watching, so it behaves the same against the in-memory filesystem.
 *
 * A rotation renames the current file to `<path>.1` and starts a fresh one. It is detected from
 * `<path>.1` becoming a different file, never from the current file shrinking: a busy daemon
 * can write more than the old offset into the fresh file between two polls. After a rotation
 * the unread rest of the old file is printed first, then the new file from its start.
 *
 * A missing log file is not an error -- no daemon has written one yet -- so it waits.
 *
 * Resolves once interrupted, with its timer cancelled and its signal handlers removed. Rejects,
 * leaving the same, if a read fails for any reason but a missing file.
 */
export async function followLog(options: FollowLogOptions): Promise<void> {
  const { clock, filesystem, path, signals, write } = options;
  const rotatedPath = `${path}.1`;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  // The tail: the rotated file, then the current one. Both reads are only trusted if the
  // rotated file is still the same one afterwards; otherwise a rotation landed in between and
  // the offset would belong to the wrong file, so the tail is read again.
  let rotatedIdentity: string | undefined;
  let tail = "";
  let offset = 0;
  for (let attempt = 0; attempt < MAX_TAIL_ATTEMPTS; attempt += 1) {
    rotatedIdentity = await identityOf(filesystem, rotatedPath);
    const rotated =
      rotatedIdentity === undefined ? "" : await readFromOrEmpty(filesystem, rotatedPath, 0);
    const current = completeLines(await readFromOrEmpty(filesystem, path, 0));
    tail = `${rotated}${current}`;
    offset = Buffer.byteLength(current, "utf8");
    if ((await identityOf(filesystem, rotatedPath)) === rotatedIdentity) break;
  }
  const tailLines = tail
    .split("\n")
    .filter((line) => line !== "")
    .slice(-(options.tailLines ?? DEFAULT_TAIL_LINES));
  if (tailLines.length > 0) write(`${tailLines.join("\n")}\n`);

  const poll = async (): Promise<void> => {
    const rotatedNow = await identityOf(filesystem, rotatedPath);
    if (rotatedNow !== undefined && rotatedNow !== rotatedIdentity) {
      rotatedIdentity = rotatedNow;
      // The old current file, now finished: everything left in it, then start the new one.
      const rest = await readFromOrEmpty(filesystem, rotatedPath, offset);
      if (rest !== "") write(rest.endsWith("\n") ? rest : `${rest}\n`);
      offset = 0;
    }
    const complete = completeLines(await readFromOrEmpty(filesystem, path, offset));
    // A rotation between the check above and this read means `offset` was applied to the new
    // file. Drop the read; the next poll sees the rotation and reads both files correctly.
    if ((await identityOf(filesystem, rotatedPath)) !== rotatedIdentity) return;
    if (complete !== "") write(complete);
    offset += Buffer.byteLength(complete, "utf8");
  };

  await new Promise<void>((resolve, reject) => {
    let timer: TimerHandle | undefined;
    let stopped = false;
    const detach = (): void => {
      stopped = true;
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
      if (timer !== undefined) clock.cancel(timer);
      timer = undefined;
    };
    function stop(): void {
      detach();
      resolve();
    }
    const schedule = (): void => {
      if (stopped) return;
      timer = clock.setTimer(intervalMs, () => {
        timer = undefined;
        if (stopped) return;
        poll().then(schedule, (error: unknown) => {
          detach();
          reject(error);
        });
      });
    };
    signals.on("SIGINT", stop);
    signals.on("SIGTERM", stop);
    schedule();
  });
}

/** Everything up to and including the last newline: a line still being written waits. */
function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

async function identityOf(filesystem: Filesystem, path: string): Promise<string | undefined> {
  try {
    return (await filesystem.stat(path)).identity;
  } catch (error: unknown) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function readFromOrEmpty(
  filesystem: Filesystem,
  path: string,
  offset: number,
): Promise<string> {
  try {
    return await filesystem.readFileFrom(path, offset);
  } catch (error: unknown) {
    if (isMissingPathError(error)) return "";
    throw error;
  }
}
