import type { InputMessage } from "../../../core/index.js";
import type { ScreenSize } from "./display-size.js";

// why: scrcpy's control message types and Android's MotionEvent actions, as the server reads them
// (scrcpy v5.0.1, ControlMessage.java and ControlMessageReader.java).
const TYPE_KEYCODE = 0;
const TYPE_TOUCH = 2;
const TYPE_SCROLL = 3;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
// why: scrcpy's id for a finger that is not a real pointer; the server tracks it like any other.
const POINTER_GENERIC_FINGER = -2n;
// why: a pressure of 1.0 as scrcpy's unsigned 16-bit fixed point.
const PRESSURE_FULL = 0xffff;
const SCROLL_UNITS = 16;

type Touch = Extract<InputMessage, { kind: "touch" }>;
type Scroll = Extract<InputMessage, { kind: "scroll" }>;

const TOUCH_ACTION = { begin: ACTION_DOWN, end: ACTION_UP, move: ACTION_MOVE } as const;

// why: positions arrive as fractions of the screen and the server wants pixels (with no video display
// it uses them as they are); the last pixel is `size - 1`, so a fraction of 1 stays on the screen.
function pixel(fraction: number, extent: number): number {
  return Math.min(extent - 1, Math.round(fraction * extent));
}

function writePosition(view: DataView, offset: number, x: number, y: number, size: ScreenSize) {
  view.setInt32(offset, pixel(x, size.width));
  view.setInt32(offset + 4, pixel(y, size.height));
  view.setUint16(offset + 8, size.width);
  view.setUint16(offset + 10, size.height);
}

export function touchPacket(message: Touch, size: ScreenSize): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  view.setUint8(0, TYPE_TOUCH);
  view.setUint8(1, TOUCH_ACTION[message.type]);
  view.setBigInt64(2, POINTER_GENERIC_FINGER);
  writePosition(view, 10, message.x, message.y, size);
  view.setUint16(22, message.type === "end" ? 0 : PRESSURE_FULL);
  return out;
}

// why: a wheel unit is 1/16 of the range scrcpy takes, so a drag of the whole screen is the full 16.
function wheelUnits(delta: number): number {
  return Math.max(-SCROLL_UNITS, Math.min(SCROLL_UNITS, Math.round(delta * SCROLL_UNITS)));
}

function fixedPoint(units: number): number {
  return Math.min(0x7fff, Math.round((units / SCROLL_UNITS) * 0x8000));
}

// why: serve-sim's positive `dy` moves the content down, which scrcpy's positive vertical scroll does;
// its positive `dx` moves the content right, which scrcpy's negative horizontal scroll does.
export function scrollPacket(message: Scroll, size: ScreenSize): Uint8Array {
  const out = new Uint8Array(21);
  const view = new DataView(out.buffer);
  view.setUint8(0, TYPE_SCROLL);
  writePosition(view, 1, message.x ?? 0.5, message.y ?? 0.5, size);
  view.setInt16(13, fixedPoint(0 - wheelUnits(message.dx)));
  view.setInt16(15, fixedPoint(wheelUnits(message.dy)));
  return out;
}

export function keycodePacket(action: "down" | "up", keycode: number, meta: number): Uint8Array {
  const out = new Uint8Array(14);
  const view = new DataView(out.buffer);
  view.setUint8(0, TYPE_KEYCODE);
  view.setUint8(1, action === "down" ? ACTION_DOWN : ACTION_UP);
  view.setInt32(2, keycode);
  view.setInt32(10, meta);
  return out;
}
