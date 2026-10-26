import type { PhysicalDriverDevice, VirtualDriverDevice } from "./driver.js";

// why: the one table in TypeScript for the input socket's tags, in the messages expo's serve-sim speaks
// (ADR 0049 section 3): a client that already speaks them drives a lease with no Simlock-specific code.
export const INPUT_TAG = {
  touch: 0x03,
  button: 0x04,
  key: 0x06,
  scroll: 0x0b,
  control: 0x10,
  config: 0x82,
  admitted: 0x83,
  controlResult: 0x90,
} as const;

// why: a client message is at most this many bytes with its tag; a longer one is dropped and the socket stays open.
export const MAX_INPUT_MESSAGE_BYTES = 64 * 1024;

// why: `ws` throws on a close reason over 123 bytes, and a client may be shown one a peer chose; cut at a character boundary, never in the middle of one.
export function closeReason(reason: string): string {
  const encoder = new TextEncoder();
  let cut = "";
  let bytes = 0;
  for (const character of reason) {
    bytes += encoder.encode(character).length;
    if (bytes > 123) break;
    cut += character;
  }
  return cut;
}

const INPUT_BUTTONS = ["home", "app_switcher", "lock", "back"] as const;

export type InputOrientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

// why: serve-sim's `0x82` payload, which T3 Code accepts only with a width and height above 0.
export interface InputScreenConfig {
  readonly width: number;
  readonly height: number;
  readonly orientation: InputOrientation;
  readonly inputUnavailable?: true;
  readonly keyboardUnavailable?: true;
}

// why: what a socket is told while its lease's device takes no input: a size T3 Code accepts and
// `inputUnavailable`, so its panel stays connected and blocks input.
export const UNAVAILABLE_INPUT_CONFIG: InputScreenConfig = {
  height: 1,
  inputUnavailable: true,
  orientation: "portrait",
  width: 1,
};

// why: what a socket's message means once it is read and checked: positions are fractions of the
// screen (0 to 1), as serve-sim sends them, and the device input turns them into its own units.
export type InputMessage =
  | {
      readonly kind: "touch";
      readonly type: "begin" | "move" | "end";
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "button"; readonly button: (typeof INPUT_BUTTONS)[number] }
  | {
      readonly kind: "scroll";
      readonly dx: number;
      readonly dy: number;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly kind: "key";
      readonly type: "down" | "up";
      readonly usage: number;
    };

// why: what turns messages into taps on one device; one per lease, shared by every socket of it.
export interface DeviceInput {
  send(message: InputMessage): void;
  // why: calls the listener with the current screen config at once, then on each change, so a socket
  // that joins late learns the size as it is now.
  onConfig(listener: (config: InputScreenConfig) => void): () => void;
  onFailed(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface UnavailableDeviceInput {
  readonly unavailable: string;
}

// why: an optional driver member beside `screenCapture`; a platform whose device cannot take input
// leaves it out, and the input module learns that from its absence rather than from a platform name.
export interface DeviceInputFactory {
  open(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    signal: AbortSignal,
  ): Promise<DeviceInput | UnavailableDeviceInput>;
}

export function isUnavailableInput(
  opening: DeviceInput | UnavailableDeviceInput,
): opening is UnavailableDeviceInput {
  return "unavailable" in opening;
}

export function encodeInputMessage(tag: number, body?: unknown): Uint8Array {
  const json =
    body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
  const message = new Uint8Array(1 + json.length);
  message[0] = tag;
  message.set(json, 1);
  return message;
}

// why: a hinge control request (0x10) is the one message a client sends that wants an answer; the answer is `{ok:false}` on every platform here.
export interface InputControlRequest {
  readonly kind: "control";
  readonly requestId: number | undefined;
}

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(bytes: Uint8Array): Fields | undefined {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Fields)
      : undefined;
  } catch {
    return undefined;
  }
}

function fraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function delta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.includes(value as T);
}

function touchOf(fields: Fields): InputMessage | undefined {
  const { type, x, y } = fields;
  if (!oneOf(type, ["begin", "move", "end"]) || !fraction(x) || !fraction(y)) return undefined;
  return { kind: "touch", type, x, y };
}

function keyOf(fields: Fields): InputMessage | undefined {
  const { type, usage } = fields;
  if (!oneOf(type, ["down", "up"])) return undefined;
  if (typeof usage !== "number" || !Number.isInteger(usage) || usage < 0 || usage > 0xff) {
    return undefined;
  }
  return { kind: "key", type, usage };
}

function scrollOf(fields: Fields): InputMessage | undefined {
  const { dx, dy, x, y } = fields;
  if (!delta(dx) || !delta(dy)) return undefined;
  if ((x !== undefined && !fraction(x)) || (y !== undefined && !fraction(y))) return undefined;
  return {
    dx,
    dy,
    kind: "scroll",
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  };
}

// why: undefined for a message that is not one the device input takes (bad JSON, an unknown tag, a position outside the screen, an orientation request), so the caller drops it and keeps the socket.
export function parseClientMessage(
  bytes: Uint8Array,
): InputMessage | InputControlRequest | undefined {
  if (bytes.length > MAX_INPUT_MESSAGE_BYTES) return undefined;
  const fields = fieldsOf(bytes);
  if (bytes[0] === INPUT_TAG.control) {
    const requestId = fields?.["requestId"];
    return {
      kind: "control",
      requestId:
        Number.isSafeInteger(requestId) && (requestId as number) > 0
          ? (requestId as number)
          : undefined,
    };
  }
  if (fields === undefined) return undefined;
  switch (bytes[0]) {
    case INPUT_TAG.touch:
      return touchOf(fields);
    case INPUT_TAG.button:
      return oneOf(fields["button"], INPUT_BUTTONS)
        ? { button: fields["button"], kind: "button" }
        : undefined;
    case INPUT_TAG.key:
      return keyOf(fields);
    case INPUT_TAG.scroll:
      return scrollOf(fields);
    default:
      return undefined;
  }
}
