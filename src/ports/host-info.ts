import { arch, release, type } from "node:os";

import type { ProcessRunner } from "./process-runner.js";

export interface HostSystem {
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
}

export interface HostInfo {
  /** why: Never throws: a fact that cannot be read falls back to what `node:os` reports. */
  read(): Promise<HostSystem>;
}

/** why: Bounds the one `sw_vers` call (architecture rule 11). It answers in milliseconds. */
const SW_VERS_TIMEOUT_MS = 5_000;

export interface NodeHostInfoOptions {
  readonly processRunner: ProcessRunner;
  /** why: `process.platform`; injected so the macOS path can be tested anywhere. */
  readonly platform: NodeJS.Platform;
}

/**
 * why: On macOS the kernel version `node:os` reports (`24.5.0`) is not the version anyone looks for,
 * so the product name and version come from `sw_vers`. Everywhere else `node:os` is the answer.
 */
export class NodeHostInfo implements HostInfo {
  constructor(private readonly options: NodeHostInfoOptions) {}

  async read(): Promise<HostSystem> {
    const fallback: HostSystem = { arch: arch(), os: type(), osVersion: release() };
    if (this.options.platform !== "darwin") return fallback;
    try {
      const result = await this.options.processRunner.run("sw_vers", [], {
        timeoutMs: SW_VERS_TIMEOUT_MS,
      });
      if (result.code !== 0) return fallback;
      const os = swVersField(result.stdout, "ProductName");
      const osVersion = swVersField(result.stdout, "ProductVersion");
      return os === undefined || osVersion === undefined
        ? fallback
        : { arch: fallback.arch, os, osVersion };
    } catch {
      return fallback;
    }
  }
}

function swVersField(output: string, key: string): string | undefined {
  const value = output
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();
  return value === undefined || value === "" ? undefined : value;
}

export class FakeHostInfo implements HostInfo {
  constructor(private readonly system: HostSystem) {}

  read(): Promise<HostSystem> {
    return Promise.resolve(this.system);
  }
}
