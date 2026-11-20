import {
  type DeviceRecord,
  encodeScreenFrame,
  encodeScreenMeta,
  type Platform,
  type ScreenFeed,
  type ScreenMeta,
  SCREEN_FRAME_TAG,
} from "../core/index.js";
import type { StreamRegistry } from "./worker-link.js";

export interface TestDevice {
  readonly id: string;
  readonly platform: Platform;
  readonly physical?: boolean;
  readonly state?: string;
}

export class TestRegistry implements StreamRegistry {
  devices: TestDevice[];
  leases: { readonly id: string; readonly deviceId: string }[];

  constructor(
    devices: TestDevice[],
    leases: { readonly id: string; readonly deviceId: string }[] = [],
  ) {
    this.devices = devices;
    this.leases = leases;
  }

  get snapshot(): StreamRegistry["snapshot"] {
    return {
      devices: this.devices.map(
        (device) =>
          ({
            address: `addr-${device.id}`,
            driverData: {},
            driverDeviceId: `drv-${device.id}`,
            enrolledApps: [],
            id: device.id,
            physical: device.physical === true,
            state: device.state ?? "ready",
            spec: { platform: device.platform },
          }) as unknown as DeviceRecord,
      ),
      leases: this.leases as unknown as StreamRegistry["snapshot"]["leases"],
    };
  }
}

export class ScriptedFeed implements ScreenFeed {
  readonly body: ReadableStream<Uint8Array>;
  closes = 0;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #done = false;

  constructor() {
    this.body = new ReadableStream<Uint8Array>({
      cancel: () => {
        this.#done = true;
      },
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }

  write(bytes: Uint8Array): void {
    if (!this.#done) this.#controller.enqueue(bytes);
  }

  meta(overrides: Partial<ScreenMeta> = {}): void {
    this.write(encodeScreenMeta({ codec: "h264", fps: 30, height: 720, width: 330, ...overrides }));
  }

  keyframe(payload: readonly number[] = [1, 2, 3]): void {
    this.frame(SCREEN_FRAME_TAG.keyframe, payload);
  }

  description(payload: readonly number[] = [9, 9]): void {
    this.frame(SCREEN_FRAME_TAG.description, payload);
  }

  delta(payload: readonly number[] = [4, 5]): void {
    this.frame(SCREEN_FRAME_TAG.delta, payload);
  }

  frame(tag: number, payload: readonly number[]): void {
    this.write(encodeScreenFrame(tag, Uint8Array.from(payload)));
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    this.#controller.close();
  }

  fail(error: Error): void {
    if (this.#done) return;
    this.#done = true;
    this.#controller.error(error);
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.end();
  }
}
