import type { PhysicalDriverDevice, VirtualDriverDevice } from "./driver.js";

// why: the one table in TypeScript for the input socket's tags, in the messages expo's serve-sim speaks
// (ADR 0049 section 3): a client that already speaks them drives a lease with no Simlock-specific code.
export const INPUT_TAG = {
  config: 0x82,
  admitted: 0x83,
} as const;

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

// why: what turns messages into taps on one device; one per lease, shared by every socket of it.
export interface DeviceInput {
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
