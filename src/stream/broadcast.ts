import { type ScreenMeta, SCREEN_FRAME_HEADER_BYTES, SCREEN_FRAME_TAG } from "../core/index.js";
import type { CapturedStream } from "./feed.js";
import { type Frame, FrameSplitter, readScreenMeta } from "./framing.js";

// why: about 10 s of today's 1500 kbps. That rides out a short stall without dropping anything and
// bounds the memory a viewer that never reads can hold.
export const MAX_VIEWER_QUEUE_BYTES = 2 * 1024 * 1024;

export interface Broadcast {
  // why: the viewer's `meta` is the capture's current one, so a joiner after a size change gets headers
  // that match the first meta frame of its body.
  join(signal: AbortSignal): CapturedStream;
  readonly viewers: number;
  readonly done: Promise<void>;
}

interface Viewer {
  queue: Frame[];
  queued: number;
  // why: a viewer that joined or fell behind skips pictures until a key frame, the first picture a
  // decoder can start from.
  waiting: boolean;
  gone: boolean;
  error: Error | undefined;
  finished: boolean;
  wake: (() => void) | undefined;
}

const PICTURES: ReadonlySet<number> = new Set([
  SCREEN_FRAME_TAG.keyframe,
  SCREEN_FRAME_TAG.delta,
  SCREEN_FRAME_TAG.seed,
  SCREEN_FRAME_TAG.alive,
]);

// why: one reader of the capture, however many viewers: it reads as fast as the capture delivers, and
// a viewer that is slow loses pictures of its own queue instead of slowing anybody else.
export function createBroadcast(source: CapturedStream): Broadcast {
  const viewers = new Set<Viewer>();
  const reader = source.body.getReader();
  const splitter = new FrameSplitter();
  let meta: ScreenMeta = source.meta;
  let metaFrame: Frame | undefined;
  let description: Frame | undefined;
  let over = false;
  let settle = () => undefined as void;
  const done = new Promise<void>((resolve) => (settle = resolve));

  const wake = (viewer: Viewer) => {
    const waiting = viewer.wake;
    viewer.wake = undefined;
    waiting?.();
  };

  const stop = () => {
    if (over) return;
    over = true;
    void (async () => {
      await reader.cancel().catch(() => undefined);
      await source.close().catch(() => undefined);
      settle();
    })();
  };

  const dropPictures = (viewer: Viewer) => {
    viewer.queue = viewer.queue.filter((frame) => !PICTURES.has(frame.tag));
    viewer.queued = viewer.queue.reduce((sum, frame) => sum + frame.bytes.length, 0);
  };

  const offer = (viewer: Viewer, frame: Frame) => {
    const push = () => {
      viewer.queue.push(frame);
      viewer.queued += frame.bytes.length;
    };
    if (!PICTURES.has(frame.tag)) {
      push();
      return;
    }
    const fits = viewer.queued + frame.bytes.length <= MAX_VIEWER_QUEUE_BYTES;
    if (frame.tag === SCREEN_FRAME_TAG.keyframe || meta.codec === "mjpeg") {
      if (!fits) dropPictures(viewer);
      viewer.waiting = false;
      push();
    } else if (viewer.waiting) {
      return;
    } else if (fits) {
      push();
    } else {
      dropPictures(viewer);
      viewer.waiting = true;
    }
  };

  const distribute = (frame: Frame) => {
    if (frame.tag === SCREEN_FRAME_TAG.meta) {
      meta = readScreenMeta(frame.bytes.subarray(SCREEN_FRAME_HEADER_BYTES));
      metaFrame = frame;
    } else if (frame.tag === SCREEN_FRAME_TAG.description) description = frame;
    for (const viewer of viewers) {
      offer(viewer, frame);
      wake(viewer);
    }
  };

  const end = (error?: Error) => {
    for (const viewer of viewers) {
      viewer.finished = true;
      viewer.error = error;
      wake(viewer);
    }
    stop();
  };

  void (async () => {
    try {
      for (;;) {
        const step = await reader.read();
        if (over) return;
        if (step.done) {
          end();
          return;
        }
        for (const frame of splitter.push(step.value)) distribute(frame);
      }
    } catch (error) {
      end(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  const leave = (viewer: Viewer) => {
    if (viewer.gone) return;
    viewer.gone = true;
    viewers.delete(viewer);
    viewer.finished = true;
    wake(viewer);
    if (viewers.size === 0) stop();
  };

  return {
    done,
    join: (signal) => {
      const viewer: Viewer = {
        error: undefined,
        finished: false,
        gone: false,
        queue: [],
        queued: 0,
        wake: undefined,
        waiting: meta.codec === "h264",
      };
      if (metaFrame !== undefined) offer(viewer, metaFrame);
      if (description !== undefined) offer(viewer, description);
      viewers.add(viewer);
      const onAbort = () => leave(viewer);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      const body = new ReadableStream<Uint8Array>(
        {
          cancel: () => leave(viewer),
          async pull(controller) {
            for (;;) {
              if (viewer.error !== undefined) {
                controller.error(viewer.error);
                return;
              }
              const next = viewer.queue.shift();
              if (next !== undefined) {
                viewer.queued -= next.bytes.length;
                controller.enqueue(next.bytes);
                return;
              }
              if (viewer.finished) {
                // why: a viewer that cancelled has a closed stream already, and closing it again throws.
                if (!viewer.gone || over) controller.close();
                return;
              }
              await new Promise<void>((resolve) => (viewer.wake = resolve));
            }
          },
        },
        { highWaterMark: 0 },
      );
      return {
        body,
        close: async () => {
          leave(viewer);
          if (viewers.size === 0) await done;
        },
        meta,
      };
    },
    get viewers() {
      return viewers.size;
    },
  };
}
