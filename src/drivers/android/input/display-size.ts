import type { ScreenTarget } from "../screen/index.js";

// why: a dumpsys that hangs is a device that does not answer; ten seconds is as long as the stream's
// own screen read waits.
const SIZE_READ_TIMEOUT_MS = 10_000;
const DISPLAY_ZERO = /mDisplayId=0\b/;
const CURRENT_SIZE = /\bcur=(\d+)x(\d+)\b/;

export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

// why: `cur=` is the logical size in the display's current rotation (a portrait phone turned to
// landscape prints `cur=2400x1080`), which is the size a position in pixels is measured against;
// `init=` and `app=` are not. Only display 0 is read.
function parseScreenSize(dump: string): ScreenSize | undefined {
  const start = dump.search(DISPLAY_ZERO);
  const match = CURRENT_SIZE.exec(start < 0 ? dump : dump.slice(start));
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { height, width } : undefined;
}

// why: a read the check refuses throws the target's own `ScreenUnavailableError`, which the caller
// tells apart from a device that answers wrongly.
export async function readScreenSize(target: ScreenTarget): Promise<ScreenSize> {
  const read = await target.run(["shell", "dumpsys", "window", "displays"], SIZE_READ_TIMEOUT_MS);
  const size = read.code === 0 ? parseScreenSize(read.stdout) : undefined;
  if (size === undefined) {
    throw new Error(
      `${target.serial} did not report its screen size (dumpsys exited ${String(read.code)})`,
    );
  }
  return size;
}
