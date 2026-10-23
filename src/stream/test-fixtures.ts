import {
  type DeviceRecord,
  encodeScreenFrame,
  encodeScreenMeta,
  type Platform,
  type ScreenFeed,
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

  constructor(devices: TestDevice[]) {
    this.devices = devices;
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

  meta(): void {
    this.write(encodeScreenMeta({ codec: "h264", fps: 30, height: 720, width: 330 }));
  }

  keyframe(payload: readonly number[] = [1, 2, 3]): void {
    this.write(encodeScreenFrame(SCREEN_FRAME_TAG.keyframe, Uint8Array.from(payload)));
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    this.#controller.close();
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.end();
  }
}
