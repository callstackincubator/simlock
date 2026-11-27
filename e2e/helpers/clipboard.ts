import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect } from "vitest";

const execFileAsync = promisify(execFile);

export async function writeClipboard(
  command: string,
  args: string[],
  value: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${String(code)}: ${stderr}`)),
    );
    child.stdin.end(value);
  });
}

export async function expectClipboardIsolated(udid: string): Promise<void> {
  const token = randomUUID();
  const host = `host-${token}`;
  const device = `device-${token}`;
  await writeClipboard("pbcopy", [], host);
  await writeClipboard("xcrun", ["simctl", "pbcopy", udid], device);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect((await execFileAsync("pbpaste")).stdout, "device clipboard did not reach host").toBe(host);
  expect(
    (await execFileAsync("xcrun", ["simctl", "pbpaste", udid])).stdout,
    "host clipboard did not reach device",
  ).toBe(device);
  const hostAgain = `host-again-${token}`;
  await writeClipboard("pbcopy", [], hostAgain);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(
    (await execFileAsync("xcrun", ["simctl", "pbpaste", udid])).stdout,
    "host change did not reach device",
  ).toBe(device);
  const deviceAgain = `device-again-${token}`;
  await writeClipboard("xcrun", ["simctl", "pbcopy", udid], deviceAgain);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect((await execFileAsync("pbpaste")).stdout, "device change did not reach host").toBe(
    hostAgain,
  );
}
