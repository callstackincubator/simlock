import type { TcpProbe } from "../../ports/index.js";
import { ADB_FAIL, adbHostRequest } from "./adb-host-protocol.js";

const SERVICE_PREFIX = "host:emulator:";

export interface AdbRegistrarOptions {
  readonly serverPort: number;
  readonly tcp: TcpProbe;
}

/**
 * Attaches an emulator to Simlock's adb server the way the emulator itself does.
 *
 * Simlock's server runs with the emulator scanner off (`ADB_EMU=0`), because the scan's
 * lower bound is hard-coded and a server that scanned far enough to see Simlock's console
 * ports would also connect to the user's emulators. With the scanner off, an emulator
 * attaches only by announcing itself -- and nothing re-announces it if that message is lost
 * or its transport is later kicked, since adb's reconnect queue is drained by the scanner
 * thread that is not running. So Simlock sends the same announcement itself, through the
 * same host service, which is what makes `ADB_EMU=0` affordable at all.
 */
export class AdbRegistrar {
  readonly #options: AdbRegistrarOptions;

  constructor(options: AdbRegistrarOptions) {
    this.#options = options;
  }

  /**
   * `adbPort` is the console port + 1: the host service takes the port the emulator serves
   * adb on, not the one it serves its console on. Safe to repeat -- adb keys transports by
   * port, so re-announcing an attached emulator is a no-op.
   */
  async register(adbPort: number): Promise<void> {
    const service = `${SERVICE_PREFIX}${adbPort}`;
    const reply = await this.#options.tcp.send(this.#options.serverPort, adbHostRequest(service));

    // adb answers `OKAY`, or closes without answering at all ("we don't even need to send a
    // reply" in its own source), so silence is success here rather than a timeout to report.
    if (reply.startsWith(ADB_FAIL)) {
      throw new Error(`adb refused ${service}: ${reply.slice(ADB_FAIL.length)}`);
    }
  }
}
