import {
  type DeviceInput,
  type DeviceInputFactory,
  encodeScreenFrame,
  INPUT_TAG,
  type InputMessage,
  type InputScreenConfig,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import type {
  BytePipeLauncher,
  BytePipeProcess,
  Clock,
  Logger,
  ProcessRunner,
} from "../../../ports/index.js";

export interface IosDeviceInputOptions {
  readonly command: string;
  readonly launcher: BytePipeLauncher;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** why: absent when the simulators live in Xcode's own set, which the helper searches by default. */
  readonly deviceSet?: string;
  readonly logger?: Logger;
}

const FRAME_HEADER_BYTES = 4;

export function createIosDeviceInput(options: IosDeviceInputOptions): DeviceInputFactory {
  return {
    open: async (device: VirtualDriverDevice | PhysicalDriverDevice) => {
      const child = options.launcher.start(options.command, [device.deviceId, "--input"], {
        env: environmentFor(options),
      });
      const config = await readConfig(child);
      return new IosDeviceInput(child, config);
    },
  };
}

// why: the daemon's own device set must not reach the helper, which would search it instead of the
// one this driver owns.
function environmentFor(options: IosDeviceInputOptions): NodeJS.ProcessEnv {
  const { SIMLOCK_IOS_DEVICE_SET: _daemonDeviceSet, ...environment } = options.baseEnvironment;
  return options.deviceSet === undefined
    ? environment
    : { ...environment, SIMLOCK_IOS_DEVICE_SET: options.deviceSet };
}

// why: the helper's stdout is the stream's envelope (a 4-byte length counting the tag, a tag, the
// payload); the first 0x82 is its size, written once its HID client is set up.
async function readConfig(child: BytePipeProcess): Promise<InputScreenConfig> {
  const reader = child.stdout.getReader();
  let buffered = new Uint8Array();
  for (;;) {
    const step = await reader.read();
    if (step.done) throw new Error("The input helper ended before it reported the screen size");
    buffered = Uint8Array.from([...buffered, ...step.value]);
    if (buffered.length < FRAME_HEADER_BYTES) continue;
    const length = new DataView(buffered.buffer).getUint32(0);
    if (buffered.length < FRAME_HEADER_BYTES + length) continue;
    const size = JSON.parse(
      new TextDecoder().decode(
        buffered.subarray(FRAME_HEADER_BYTES + 1, FRAME_HEADER_BYTES + length),
      ),
    ) as { width: number; height: number };
    return { height: size.height, orientation: "portrait", width: size.width };
  }
}

function frameOf(tag: number, body: unknown): Uint8Array {
  return encodeScreenFrame(tag, new TextEncoder().encode(JSON.stringify(body)));
}

class IosDeviceInput implements DeviceInput {
  readonly #child: BytePipeProcess;
  readonly #config: InputScreenConfig;

  constructor(child: BytePipeProcess, config: InputScreenConfig) {
    this.#child = child;
    this.#config = config;
  }

  send(message: InputMessage): void {
    if (message.kind !== "touch") return;
    const { type, x, y } = message;
    void this.#child.writeStdin(frameOf(INPUT_TAG.touch, { type, x, y }));
  }

  onConfig(listener: (config: InputScreenConfig) => void): () => void {
    listener(this.#config);
    return () => undefined;
  }

  onFailed(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
