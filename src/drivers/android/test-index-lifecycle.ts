import { type ScriptedProcessExpectation } from "../../ports/index.js";
import { avdDirectory, binaries, processResult } from "./testing.js";

/** why: what a running AVD made before copies answers to `emu avd path`: `<root>/<name>.avd`. */
export function avdPathExpectation(
  serial: string,
  avdName = "simlock_one",
): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${avdName}.avd\r\nOK\r\n`,
  );
}
