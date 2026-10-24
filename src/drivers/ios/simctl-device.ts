/**
 * why: ADR 0047 §1. `xcrun simctl help` (Xcode 27.0) puts the device first among a verb's
 * operands for these verbs; a verb on neither list passes as the caller wrote it.
 */
const DEVICE_FIRST_VERBS: ReadonlySet<string> = new Set([
  "addmedia",
  "appinfo",
  "boot",
  "bootstatus",
  "get_app_container",
  "getenv",
  "icloud_sync",
  "install",
  "install_app_data",
  "io",
  "keychain",
  "listapps",
  "location",
  "openurl",
  "privacy",
  "push",
  "reboot",
  "rename",
  "shutdown",
  "status_bar",
  "terminate",
  "ui",
  "uninstall",
  "upgrade",
]);

/** why: These verbs take their own options first, then the device; only `-a` takes a separate value. */
const DEVICE_AFTER_OPTIONS_VERBS: ReadonlySet<string> = new Set([
  "launch",
  "spawn",
  "pbcopy",
  "pbpaste",
]);

const OPTION_WITH_SEPARATE_VALUE = "-a";

/** why: A caller may leave the device out (ADR 0047 §1); this puts it where `simctl` expects it unless the caller already named it. */
export function fillSimctlDevice(args: readonly string[], udid: string): readonly string[] {
  const verb = args[0];
  if (verb === undefined) return args;
  let index = 1;
  if (DEVICE_AFTER_OPTIONS_VERBS.has(verb)) {
    while (args[index]?.startsWith("-") === true) {
      index += args[index] === OPTION_WITH_SEPARATE_VALUE ? 2 : 1;
    }
  } else if (!DEVICE_FIRST_VERBS.has(verb)) {
    return args;
  }
  if (args[index]?.toLowerCase() === udid.toLowerCase()) return args;
  return [...args.slice(0, index), udid, ...args.slice(index)];
}
