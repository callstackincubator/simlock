import { PassthroughRefusedError } from "../core/index.js";

/**
 * why: One message for every driver and tool that refuses a command naming another device
 * (ADR 0047 §2); `named` is what the caller wrote, `own` the lease's UDID or serial.
 */
export function otherDeviceRefusal(
  tool: string,
  args: readonly string[],
  named: string,
  own: string,
): PassthroughRefusedError {
  return new PassthroughRefusedError(
    tool,
    `Refusing \`${[tool, ...args].join(" ")}\`: it names device ${named}, and this lease holds ${own}. Leave the device out; Simlock fills it in.`,
  );
}
