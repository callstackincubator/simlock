import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * why: a fake `gh`, `tsc` or `pnpm` on PATH is a script; Windows starts only `.exe` files from
 * `spawn` without a shell, so there each fake also gets a copy of node's own binary under the
 * fake's name, and `NODE_OPTIONS` preloads a shim that makes that copy run the script.
 */
const WINDOWS = process.platform === "win32";

const SHIM_DIR = join(tmpdir(), "simlock-fake-command");
const SHIM_FILE = join(SHIM_DIR, "shim.cjs");
const NODE_COPY = join(SHIM_DIR, "node-copy.exe");

// why: the shim runs inside the copied binary, so it reads the script that sits beside it (the
// binary's path without `.exe`) and runs it with the interpreter its first line names.
const SHIM = `
const { basename } = require("node:path");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const exe = process.execPath;
if (/\\.exe$/i.test(exe) && basename(exe).toLowerCase() !== "node.exe") {
  const script = exe.slice(0, -4);
  const first = readFileSync(script, "utf8").split("\\n", 1)[0];
  const interpreter = /node/.test(first) ? process.env.SIMLOCK_FAKE_NODE : process.env.SIMLOCK_FAKE_BASH;
  const result = spawnSync(interpreter, [script, ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`;

// why: `bash` alone may be the WSL launcher in System32 on Windows, not Git Bash.
export const BASH = WINDOWS ? gitBash() : "bash";

function gitBash(): string {
  const candidate = join(
    process.env["ProgramFiles"] ?? "C:\\Program Files",
    "Git",
    "bin",
    "bash.exe",
  );
  return existsSync(candidate) ? candidate : "bash";
}

export function writeFakeCommand(dir: string, name: string, source: string): void {
  const file = join(dir, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  if (!WINDOWS) return;
  mkdirSync(SHIM_DIR, { recursive: true });
  ensure(SHIM_FILE, (to) => writeFileSync(to, SHIM));
  ensure(NODE_COPY, (to) => copyFileSync(process.execPath, to));
  const target = join(dir, `${name}.exe`);
  try {
    linkSync(NODE_COPY, target);
  } catch {
    // why: a hard link needs the same volume; a copy of the binary works on any.
    copyFileSync(NODE_COPY, target);
  }
}

// why: test workers run in parallel and share these files; a worker that sees one must never see
// it half written, so each is made under another name and renamed into place.
function ensure(file: string, create: (to: string) => void): void {
  if (existsSync(file)) return;
  const partial = `${file}.${process.pid}`;
  create(partial);
  try {
    renameSync(partial, file);
  } catch {
    // why: another worker renamed its copy first, and a running binary cannot be replaced.
  }
}

// why: `tail` replaces the rest of PATH on a POSIX host, where a test can hide the real tools; on
// Windows the rest stays, because node and bash live there.
export function fakeCommandEnv(dir: string, tail?: string): NodeJS.ProcessEnv {
  const rest = WINDOWS || tail === undefined ? (process.env["PATH"] ?? "") : tail;
  const env: NodeJS.ProcessEnv = { PATH: `${dir}${delimiter}${rest}` };
  if (WINDOWS) {
    env["NODE_OPTIONS"] = `--require ${SHIM_FILE.replaceAll("\\", "/")}`;
    env["SIMLOCK_FAKE_NODE"] = process.execPath;
    env["SIMLOCK_FAKE_BASH"] = BASH;
  }
  return env;
}
