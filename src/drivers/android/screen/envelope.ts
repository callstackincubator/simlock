import { encodeScreenFrame, encodeScreenMeta, SCREEN_FRAME_TAG } from "../../../core/index.js";
import {
  avcDecoderConfiguration,
  H264FormatError,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
  nalType,
  splitAnnexB,
  toAvcc,
} from "./h264.js";
import type { ScrcpyVideoEvent } from "./scrcpy-video.js";

// why: the browser refuses a frame longer than this, and a stream it refuses mid-way is a viewer left
// with a frozen picture; refusing here names the cause on the daemon's side instead.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class EnvelopeMapper {
  readonly #fps: number;
  #sps: Uint8Array[] = [];
  #pps: Uint8Array[] = [];
  #descriptionDue = false;
  #sessionSeen = false;

  constructor(fps: number) {
    this.#fps = fps;
  }

  // fallow-ignore-next-line complexity -- one branch per scrcpy event, each the frames it becomes.
  map(event: ScrcpyVideoEvent): Uint8Array[] {
    if (event.kind === "session") {
      this.#sessionSeen = true;
      // why: a new session is a new encoder (the device rotated, or the server downsized after an
      // encoder error), so the parameter sets of the last one say nothing about the next picture.
      this.#sps = [];
      this.#pps = [];
      this.#descriptionDue = false;
      return [
        encodeScreenMeta({
          codec: "h264",
          fps: this.#fps,
          height: event.height,
          width: event.width,
        }),
      ];
    }
    if (!this.#sessionSeen) {
      throw new H264FormatError("The screen server sent video before it named the picture's size");
    }
    const nals = splitAnnexB(event.payload);
    if (event.config) {
      // why: an encoder may hand its sequence and picture parameter sets over in one config packet or
      // in two, so the description waits for the first picture rather than for the first config.
      const sps = nals.filter((nal) => nalType(nal) === NAL_TYPE_SPS);
      const pps = nals.filter((nal) => nalType(nal) === NAL_TYPE_PPS);
      if (sps.length > 0) this.#sps = sps;
      if (pps.length > 0) this.#pps = pps;
      this.#descriptionDue = true;
      return [];
    }
    const frames: Uint8Array[] = [];
    if (this.#descriptionDue) {
      frames.push(
        encodeScreenFrame(
          SCREEN_FRAME_TAG.description,
          avcDecoderConfiguration(this.#sps, this.#pps),
        ),
      );
      this.#descriptionDue = false;
    } else if (this.#sps.length === 0) {
      throw new H264FormatError("The screen server sent a picture before its parameter sets");
    }
    const picture = encodeScreenFrame(
      event.key ? SCREEN_FRAME_TAG.keyframe : SCREEN_FRAME_TAG.delta,
      toAvcc(nals),
    );
    if (picture.length > MAX_FRAME_BYTES) {
      throw new H264FormatError(
        `A ${String(picture.length)}-byte frame is past what a viewer reads`,
      );
    }
    frames.push(picture);
    return frames;
  }
}
