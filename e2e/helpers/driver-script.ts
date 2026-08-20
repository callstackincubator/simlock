import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FakeDriverLogEntry, FakeDriverScript } from "../fake-driver/types.js";

/** Mutates the fake driver's JSON script file; the daemon re-reads it on every call. */
export interface DriverScriptControl {
  /** Replaces the whole script (both platforms). */
  set(script: FakeDriverScript): Promise<void>;
  /** Shallow-merges into whichever platform keys are present, leaving others untouched. */
  merge(script: FakeDriverScript): Promise<void>;
  /** Deletes the script file so the driver falls back to defaults. */
  clear(): Promise<void>;
  get(): Promise<FakeDriverScript>;
  readonly path: string;
}

/** Reads the fake driver's append-only JSON-lines call log. */
export interface DriverLogControl {
  calls(): Promise<FakeDriverLogEntry[]>;
  clear(): Promise<void>;
  readonly path: string;
}

export function driverScriptControl(scriptPath: string): DriverScriptControl {
  return {
    path: scriptPath,
    async set(script) {
      await mkdir(dirname(scriptPath), { recursive: true });
      await writeFile(scriptPath, JSON.stringify(script, null, 2), "utf8");
    },
    async merge(script) {
      const current = await this.get();
      const ios = script.ios === undefined ? current.ios : { ...current.ios, ...script.ios };
      const android =
        script.android === undefined ? current.android : { ...current.android, ...script.android };
      await this.set({
        ...(ios === undefined ? {} : { ios }),
        ...(android === undefined ? {} : { android }),
      });
    },
    async clear() {
      await rm(scriptPath, { force: true });
    },
    async get() {
      try {
        return JSON.parse(await readFile(scriptPath, "utf8")) as FakeDriverScript;
      } catch {
        return {};
      }
    },
  };
}

export function driverLogControl(logPath: string): DriverLogControl {
  return {
    path: logPath,
    async calls() {
      let contents: string;
      try {
        contents = await readFile(logPath, "utf8");
      } catch {
        return [];
      }
      return contents
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as FakeDriverLogEntry);
    },
    async clear() {
      await rm(logPath, { force: true });
    },
  };
}
