import { win32 } from "node:path";

export interface ChildLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

const BATCH_FILE = /\.(?:bat|cmd)$/i;

// why: every character cmd.exe gives a meaning to; each is escaped with `^` so it stays text.
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeForCmd(text: string): string {
  return text.replace(CMD_METACHARACTERS, "^$1");
}

/**
 * why: under the C runtime's argv rules, backslashes before the closing quote are doubled, or they
 * would escape it. The escapes are for this `cmd.exe /c` only: the script receives each argument
 * quoted, and inside quotes its own lines (`if "x%~1" == "x"`, `set ARGS=%*`) read every character
 * as text. Escaping twice would leave a `^"` there, which breaks the script's syntax.
 */
function quoteArgument(argument: string): string {
  return escapeForCmd(`"${argument.replace(/(\\*)$/, "$1$1")}"`);
}

/**
 * why: Node refuses to spawn a `.bat` or `.cmd` without a shell (EINVAL) since CVE-2024-27980,
 * https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2, and the Android SDK's
 * `sdkmanager` and `avdmanager` are batch files on Windows. They run through `cmd.exe /d /s /c`
 * with every argument quoted and escaped, so no argument is ever read as a second command.
 * Anything else, and every command off Windows, is spawned as it is.
 */
export function childLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec,
): ChildLaunch {
  if (platform !== "win32" || !BATCH_FILE.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  // why: cmd.exe expands `%name%` before any escape applies, a line break ends the command, and a
  // script that reads its arguments inside quotes (the SDK's all do) takes an embedded `"` as the
  // end of one; none can be passed through safely, and no SDK call needs any of them.
  const unsafe = args.find((argument) => /[%"\r\n]/.test(argument));
  if (unsafe !== undefined) {
    throw new Error(
      `Refusing to run ${command}: the argument ${JSON.stringify(unsafe)} holds a %, a " or a line break, which cmd.exe cannot pass to a batch file unchanged`,
    );
  }
  // why: SDK paths are joined with `/`, and cmd.exe can read `/cmdline-tools` in a command as a switch.
  const line = [escapeForCmd(win32.normalize(command)), ...args.map(quoteArgument)].join(" ");
  return {
    command: comSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
