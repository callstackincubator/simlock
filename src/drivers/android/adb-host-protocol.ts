// why: adb's host protocol is a length-prefixed request answered by `OKAY` or by `FAIL` and a
// length-prefixed reason, the same framing in both directions:
// https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_io.cpp
const LENGTH_PREFIX_DIGITS = 4;

export const ADB_OKAY = "OKAY";
export const ADB_FAIL = "FAIL";
export const ADB_STATUS_BYTES = 4;
export const ADB_LENGTH_BYTES = LENGTH_PREFIX_DIGITS;

export function adbHostRequest(service: string): string {
  return `${service.length.toString(16).padStart(LENGTH_PREFIX_DIGITS, "0")}${service}`;
}
