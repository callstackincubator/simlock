import { join } from "node:path";
import type { ObservedMark } from "../../core/index.js";
import type { Clock, Filesystem, IdGenerator } from "../../ports/index.js";
import { isRecord, parseManagedDevices } from "./simctl-parse.js";

interface DeviceMarksOptions {
  readonly clock: Clock;
  readonly deviceRoot: string;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly ownsDeviceSet: boolean;
}

const MARK_FILE_NAME = "simlock-mark.json";

/** why: the part of IosSimctlDriver (ADR 0063) that writes, reads and checks the durable and erasable marks Simlock leaves on each simulator it makes. */
export class DeviceMarks {
  readonly #clock: Clock;
  readonly #deviceRoot: string;
  readonly #filesystem: Filesystem;
  readonly #idGenerator: IdGenerator;
  readonly #instanceId: string;
  readonly #ownsDeviceSet: boolean;

  constructor(options: DeviceMarksOptions) {
    this.#clock = options.clock;
    this.#deviceRoot = options.deviceRoot;
    this.#filesystem = options.filesystem;
    this.#idGenerator = options.idGenerator;
    this.#instanceId = options.instanceId;
    this.#ownsDeviceSet = options.ownsDeviceSet;
  }

  #deviceDirectory(udid: string): string {
    return join(this.#deviceRoot, udid);
  }

  #dataPathFor(udid: string): string {
    return join(this.#deviceDirectory(udid), "data");
  }

  /**
   * why: Writes the same provenance token into both regions of a device: the
   * device root (durable -- survives `simctl erase`) and the data container
   * (erasable -- destroyed by it).
   *
   * The erasable half goes first, and the two are not written concurrently, because a
   * half-written pair is read by `Doctor` as tampering: durable-without-erasable is
   * exactly the signature of a foreign erase. Writing the fragile half first means a
   * failure (`<root>/<udid>/data` is not there, so `writeFileAtomic` -- which creates no
   * parents -- cannot land) leaves *neither* mark, which reads as "never marked" and
   * produces no finding at all. The write still throws, so the caller learns something
   * was wrong with the device; what it must never do is accuse the user of erasing a
   * device Simlock itself just erased.
   */
  async writeMark(udid: string): Promise<void> {
    const token = this.#idGenerator.generate();
    const contents = JSON.stringify({
      instanceId: this.#instanceId,
      token,
      udid,
      writtenAt: new Date(this.#clock.now()).toISOString(),
    });

    await this.#filesystem.writeFileAtomic(join(this.#dataPathFor(udid), MARK_FILE_NAME), contents);
    await this.#filesystem.writeFileAtomic(
      join(this.#deviceDirectory(udid), MARK_FILE_NAME),
      contents,
    );
  }

  async readMark(udid: string): Promise<ObservedMark | undefined> {
    const durable = await this.#readToken(join(this.#deviceDirectory(udid), MARK_FILE_NAME));
    const erasable = await this.#readToken(join(this.#dataPathFor(udid), MARK_FILE_NAME));

    if (durable === undefined && erasable === undefined) {
      return undefined;
    }

    return { durable, erasable, erasableReadable: true };
  }

  async #readToken(path: string): Promise<string | undefined> {
    return (await this.#readMarkFile(path))?.token;
  }

  async #readMarkFile(
    path: string,
  ): Promise<{ readonly token: string; readonly instanceId: string | undefined } | undefined> {
    try {
      const contents = await this.#filesystem.readFile(path);
      const parsed = JSON.parse(contents) as unknown;
      if (!isRecord(parsed) || typeof parsed.token !== "string" || parsed.token === "") {
        return undefined;
      }
      return {
        instanceId:
          typeof parsed.instanceId === "string" && parsed.instanceId !== ""
            ? parsed.instanceId
            : undefined,
        token: parsed.token,
      };
    } catch {
      return undefined;
    }
  }

  /** why: Under Xcode's set the default set holds this instance's simulators too, and they are not foreign. */
  async ownedUdids(listed: unknown): Promise<ReadonlySet<string>> {
    if (this.#ownsDeviceSet || !isRecord(listed) || !isRecord(listed.devices)) {
      return new Set();
    }
    const udids = parseManagedDevices(listed).map((device) => device.udid);
    const owned = await Promise.all(udids.map((udid) => this.isMarkedByThisInstance(udid)));
    return new Set(udids.filter((_udid, index) => owned[index]));
  }

  async isMarkedByThisInstance(udid: string): Promise<boolean> {
    const durable = await this.#readMarkFile(join(this.#deviceDirectory(udid), MARK_FILE_NAME));
    return durable?.instanceId === this.#instanceId;
  }
}
